// dsh-btw — 会话读取（host 半边内部模块，**只读**）
//
// 落盘格式（0.2.0-rc.x 实测，与 dsh-writing-style 同源结论）：
//   $DSH_HOME/sessions/--<cwd 编码>--/<sessionId>/session.v4.jsonl.zstd
// 文件是**多帧 zstd 追加**（每个 flush 一帧，实测 1MB 文件 507 帧），
// 不能整体解压：必须扫 zstd magic `28 B5 2F FD` 切帧、逐帧解压再拼接，
// 否则只拿到第一帧（症状是"会话看起来是空的"）。
//
// 只取两类事件：
//   · `user/message` 且 `data.source.kind === "user"`  → role user
//     （同一条 type 被真人输入 / 系统注入 / 子代理提示词 / 工具转述共用，
//      source.kind 才是宿主区分来源的字段）
//   · `assistant/message` 的 `content[].type === "text"` → role assistant
//     （reasoning / tool_use 一律丢掉 —— 旁问要的是"会话里已经说过的内容"）
//
// 本模块不含任何写入路径。

const fs = process.getBuiltinModule("node:fs");
const fsp = process.getBuiltinModule("node:fs/promises");
const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");
const zlib = process.getBuiltinModule("node:zlib");

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 单文件读取上限：旁问不需要全量，超大会话直接放弃尾读。 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SESSION_FILENAMES = ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd"];

export function dshHome() {
	const env = process.env.DSH_HOME;
	return typeof env === "string" && env !== "" ? env : path.join(os.homedir(), ".dsh");
}

export function sessionsRoot() {
	return path.join(dshHome(), "sessions");
}

/**
 * cwd → 会话目录名。DSH 的编码规则（实测）：
 *   · 去掉前导 `/`，`/` 一律换 `-`，两端各补一个 `-`；
 *   · 非 ASCII 字符逐个转成 `~XXXX`（UTF-16 码元、大写 hex、补足 4 位）。
 */
export function encodeCwd(cwd) {
	const trimmed = String(cwd).replace(/^\/+/, "");
	let out = "";
	for (const ch of trimmed) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "/") out += "-";
		else if (code < 0x20 || code > 0x7e) {
			for (let i = 0; i < ch.length; i++) out += "~" + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
		} else out += ch;
	}
	return "--" + out + "--";
}

/** 把一个 session.vN.jsonl.zstd 解成事件数组（切帧 + 逐帧解压 + 拼 JSONL）。 */
export function readSessionEvents(file) {
	let buf;
	try {
		const st = fs.statSync(file);
		if (st.size > MAX_FILE_BYTES) return [];
		buf = fs.readFileSync(file);
	} catch {
		return [];
	}
	const offsets = [];
	let i = 0;
	while (true) {
		const k = buf.indexOf(ZSTD_MAGIC, i);
		if (k < 0) break;
		offsets.push(k);
		i = k + 4;
	}
	let text = "";
	for (let j = 0; j < offsets.length; j++) {
		const seg = buf.subarray(offsets[j], j + 1 < offsets.length ? offsets[j + 1] : buf.length);
		try {
			text += zlib.zstdDecompressSync(seg).toString("utf8");
		} catch {
			// 单帧坏掉不该让整个会话作废（切帧靠 magic 猜测，偶有伪命中）。
		}
	}
	const out = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// 半行（正在写入的最后一帧）直接跳过。
		}
	}
	return out;
}

/**
 * 只按 sessionId 定位会话文件：不知道 cwd 也不影响
 * （sessionId 是 UUID，在 sessions 的各个工作区目录下唯一）。
 * @returns {Promise<{file:string,mtime:number,size:number,workspace:string,sessionId:string}|null>}
 */
export async function findSessionFile(sessionId, root = sessionsRoot()) {
	if (typeof sessionId !== "string" || sessionId === "") return null;
	let dirs;
	try {
		dirs = await fsp.readdir(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		for (const name of SESSION_FILENAMES) {
			const f = path.join(root, d.name, sessionId, name);
			try {
				const st = await fsp.stat(f);
				if (st.isFile()) return { file: f, mtime: st.mtimeMs, size: st.size, workspace: d.name, sessionId };
			} catch {
				// 换下一个候选名 / 下一个工作区
			}
		}
	}
	return null;
}

function joinTextBlocks(blocks) {
	if (!Array.isArray(blocks)) return "";
	const parts = [];
	for (const block of blocks) {
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

function clip(text, max) {
	if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
	return text.slice(0, max) + `\n…（此处省略 ${text.length - max} 字）`;
}

/**
 * 组装对话轮次。从最新往回吃到预算，保证"越近的内容越完整"。
 * @returns {{turns:Array<{role:"user"|"assistant",text:string}>, total:number, chars:number}}
 */
export function buildTranscript(events, options = {}) {
	const maxTurns = Number.isFinite(options.maxTurns) ? options.maxTurns : 60;
	const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 60000;
	const maxCharsPerTurn = Number.isFinite(options.maxCharsPerTurn) ? options.maxCharsPerTurn : 6000;

	const all = [];
	for (const ev of events) {
		if (ev?.type === "user/message") {
			if (ev?.data?.source?.kind !== "user") continue;
			const text = joinTextBlocks(ev?.data?.content);
			if (text !== "") all.push({ role: "user", text: clip(text, maxCharsPerTurn) });
		} else if (ev?.type === "assistant/message") {
			const text = joinTextBlocks(ev?.data?.message?.content);
			if (text !== "") all.push({ role: "assistant", text: clip(text, maxCharsPerTurn) });
		}
	}

	const turns = [];
	let chars = 0;
	for (let i = all.length - 1; i >= 0; i--) {
		const t = all[i];
		if (turns.length >= maxTurns) break;
		if (turns.length > 0 && chars + t.text.length > maxChars) break;
		turns.push(t);
		chars += t.text.length;
	}
	turns.reverse();
	return { turns, total: all.length, chars };
}

/**
 * 会话最近一次真正在用的模型（旁问默认跟随它）。
 *
 * 三个来源，倒序取最近一条能同时给出 provider + model 的：
 *   · `request/context` —— 每个请求都写，最可靠（实测 {provider, model, contextWindow}）
 *   · `request/header`  —— 兜底，路径是 data.header.config.{provider,model}
 *   · `model/selection` —— 用户显式切换模型时才写
 */
export function extractModelSelection(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		const t = ev?.type;
		const d = ev?.data ?? {};
		let provider;
		let model;
		if (t === "request/context") {
			provider = d.provider;
			model = d.model;
		} else if (t === "request/header") {
			provider = d.header?.config?.provider;
			model = d.header?.config?.model;
		} else if (t === "model/selection") {
			provider = d.provider ?? d.providerId ?? d.route;
			model = d.model ?? d.modelId;
		} else continue;
		if (typeof provider === "string" && provider !== "" && typeof model === "string" && model !== "") {
			return { provider, model };
		}
	}
	return null;
}

/** 会话标题（浮层上显示"在问哪个会话"）。 */
export function extractTitle(events) {
	let title = "";
	for (const ev of events) {
		if (ev?.type !== "session/title") continue;
		const t = ev?.data?.title ?? ev?.data?.text;
		if (typeof t === "string" && t.trim() !== "") title = t.trim();
	}
	return title;
}

/** 按 mtime 列出最近的会话文件（只用于"借一个默认模型"）。 */
export async function listRecentSessionFiles(root = sessionsRoot(), limit = 16) {
	const out = [];
	let dirs;
	try {
		dirs = await fsp.readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		let subs;
		try {
			subs = await fsp.readdir(path.join(root, d.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const s of subs) {
			if (!s.isDirectory()) continue;
			for (const name of SESSION_FILENAMES) {
				const f = path.join(root, d.name, s.name, name);
				try {
					const st = await fsp.stat(f);
					if (st.isFile()) {
						out.push({ file: f, mtime: st.mtimeMs, size: st.size, workspace: d.name, sessionId: s.name });
						break;
					}
				} catch {
					// 换下一个候选名
				}
			}
		}
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out.slice(0, limit);
}

/**
 * 往前翻最近用过的会话，借一个 provider/model。
 * 场景：在一个**还没发过消息**的新会话里旁问 —— 它自己没有 `request/context`，
 * 光靠 `listProviders()` 只会拿到 provider 名、拿不到模型（实测回落到
 * `provider="gpt" model=""` → `UNKNOWN_MODEL`）。用户日常在用的那个模型最靠谱。
 */
export async function findRecentModelSelection(root = sessionsRoot(), limit = 16) {
	for (const item of await listRecentSessionFiles(root, limit)) {
		const model = extractModelSelection(readSessionEvents(item.file));
		if (model !== null) return model;
	}
	return null;
}
