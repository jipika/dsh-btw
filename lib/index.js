// dsh-btw — host 半边：一个真正注册进 DSH 命令面的斜杠命令 `/btw`
//
// 对齐 Claude Code 的 `/btw`（旁问 / side question）：问一个关于**当前会话**的侧面问题，
// 答案不进对话历史、不打断正在跑的轮次、没有工具访问。
//
// 走 DSH 的原生命令面（`ctx.commands.register()`），不自建浮层、也不注册 webServer 路由：
//   · 斜杠在第 0 字节 + 小写名 = 命令，handler 直接对 agent 运行，**不产生 model message**；
//   · 生命周期事件 `command/run` / `command/done` 是仅日志事件、没有轮次包裹，
//     UI 在**模型历史之外**渲染结算文本 —— 所以旁问的问答都不进模型上下文。
//
// 三条性质因此是结构性的，不是靠提示词自律：
//   · 不进历史     —— handler 不产生 user/assistant 消息，也不写会话；
//   · 不打断当前轮 —— 上下文只读内存视图（或磁盘会话文件的兜底读），完全不碰 steer / queue 通道；
//   · 无工具访问   —— `llm.stream` 单轮请求，messages 里只有文本，没有注册任何工具。
//
// 上下文数据源（按优先级）：
//   1. `agent.session`（官方 Session 类）：`snapshotEvents()` 是**实时**事件（含尚未落盘的步骤）、
//      `requestContext()` 直接给出当前 provider/model、`id` 是 SessionId —— 零 IO、不依赖磁盘格式；
//   2. 磁盘会话文件 `$DSH_HOME/sessions/…/session.v4.jsonl.zstd`（多帧 zstd）—— 只在拿不到
//      session 视图时兜底。
//
// 代价：只看得到会话里已经出现过的内容（用户消息 + 助手回复正文，忽略 reasoning 与工具细节）。
// 要它去发现新东西，用子代理。

import { buildTranscript, extractModelSelection, findRecentModelSelection, findSessionFile, readSessionEvents } from "./transcript.js";

export const name = "dsh-btw";

/**
 * `llm` / `commands` 都必须显式声明：cordis 对**未注入**的服务访问会抛
 * `cannot get property "llm" without inject`（实测踩到过 —— 用可选链也拦不住，
 * 因为抛的是属性 getter 本身）。
 * `commands` 是命令面服务：无 UI 的演示主干与 ACP 自动化不提供它，那里本插件自然不激活。
 */
export const inject = ["llm", "commands"];

const COMMAND_NAME = "btw";
/** 上下文预算：取多了没用（旁问要的是"会话里已经说过的"），取少了答不准。 */
const TRANSCRIPT_LIMITS = { maxTurns: 60, maxChars: 60000, maxCharsPerTurn: 6000 };

const log = (...a) => console.log("[dsh-btw]", ...a);

const SYSTEM_PROMPT = [
	"你是「旁问」助手。用户正在一个进行中的会话里，插了一个侧面问题，需要你只根据这个会话已经出现过的内容来回答。",
	"",
	"规则：",
	"1. 只能依据下面给出的会话上下文回答。上下文里没有的，直接说不知道或没有提到过，不要推测、不要编。",
	"2. 你没有工具：不能读文件、不能跑命令、不能搜索。不要说要去看什么、去跑什么。",
	"3. 回答要短而直接。通常一两句话；确实需要列举时才用列表。",
	"4. 不要复述上下文，也不要用「根据上下文」这类开场白，直接给答案。",
	"5. 用与用户提问相同的语言回答。",
].join("\n");

/**
 * 取会话视图：优先官方 Session 对象（实时、零 IO），失败再读磁盘。
 *
 * 类型依据（来自 DSH 声明）：
 *   `Agent { readonly id: SessionId; readonly session: Session }`
 *   `Session { get id(): SessionId; snapshotEvents(): readonly SessionEvent[];
 *              ownEvents(): readonly SessionEvent[]; requestContext(): RequestContext | undefined }`
 * 事件形状与磁盘 JSONL 一致（`{ type, seq, time, data }`），所以 `buildTranscript` 两边通吃。
 */
async function readSession(agent) {
	const session = agent?.session;
	if (session !== undefined && session !== null) {
		try {
			const events =
				typeof session.snapshotEvents === "function"
					? Array.from(session.snapshotEvents() ?? [])
					: typeof session.ownEvents === "function"
						? Array.from(session.ownEvents() ?? [])
						: [];
			if (events.length > 0) {
				const id = String(session.id ?? agent?.id ?? "");
				let model = null;
				if (typeof session.requestContext === "function") {
					const rc = session.requestContext();
					if (rc !== undefined && rc !== null && typeof rc.provider === "string" && rc.provider !== "" && typeof rc.model === "string" && rc.model !== "") {
						model = { provider: rc.provider, model: rc.model };
					}
				}
				return { sessionId: id, via: "session", events, model };
			}
		} catch (error) {
			log(`session view failed, falling back to disk: ${String(error?.message ?? error)}`);
		}
	}

	// 兜底：磁盘会话文件（多帧 zstd）。字段名没有对外承诺，所以按可能性依次试。
	const candidates = [
		["agent.session.id", agent?.session?.id],
		["agent.id", agent?.id],
		["agent.sessionId", agent?.sessionId],
	];
	let id = "";
	let via = "none";
	for (const [label, value] of candidates) {
		if (typeof value === "string" && value !== "") {
			id = value;
			via = label;
			break;
		}
	}
	const found = await findSessionFile(id);
	return { sessionId: id, via: `${via}/file`, events: found !== null ? readSessionEvents(found.file) : [], model: null };
}

/** 旁问用哪个模型：会话当前在用的 > 会话记录里最近用过的 > 最近任意会话 > provider 目录第一个模型。 */
async function pickModel(llm, events, fromSession) {
	if (fromSession !== null) return fromSession;
	const fromEvents = extractModelSelection(events);
	if (fromEvents !== null) return fromEvents;
	const recent = await findRecentModelSelection();
	if (recent !== null) return recent;
	let providers = [];
	try {
		providers = llm?.listProviders?.() ?? [];
	} catch {
		providers = [];
	}
	for (const p of providers) {
		if (typeof p === "string") continue;
		const id = p?.id ?? p?.name;
		if (typeof id !== "string" || id === "") continue;
		const models = p?.models ?? p?.modelIds ?? p?.catalog;
		const first = Array.isArray(models) && models.length > 0 ? (typeof models[0] === "string" ? models[0] : models[0]?.id ?? models[0]?.name) : undefined;
		if (typeof first === "string" && first !== "") return { provider: id, model: first };
	}
	throw new Error("找不到可用模型：请在任意会话里先发一条消息再旁问");
}

/** 跑一次旁问：读会话 → 单轮无工具请求 → 返回答案文本。 */
async function ask(llm, agent, question) {
	const { sessionId, via, events, model } = await readSession(agent);
	const { turns, total, chars } = buildTranscript(events, TRANSCRIPT_LIMITS);
	const picked = await pickModel(llm, events, model);
	log(`ask via=${via} session=${sessionId || "-"} events=${events.length} turns=${turns.length}/${total} chars=${chars} model=${picked.provider}/${picked.model}`);

	const contextText =
		turns.length === 0
			? "（当前会话还没有任何对话内容，或会话不可读。）"
			: turns.map((t, i) => `#${i + 1} ${t.role === "user" ? "用户" : "助手"}：\n${t.text}`).join("\n\n---\n\n");
	const messages = [
		{ role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
		{
			role: "user",
			content: [
				{
					type: "text",
					text: `【当前会话上下文（共 ${turns.length} 条，从旧到新）】\n\n${contextText}\n\n【旁问】\n${question}`,
				},
			],
		},
	];

	let out = "";
	for await (const chunk of llm.stream({ provider: picked.provider, model: picked.model, messages })) {
		const t = chunk?.type;
		if (t === "text-delta") {
			out += chunk.text ?? chunk.delta ?? "";
		} else if (t === "finish" && chunk?.reason !== null && typeof chunk?.reason === "object" && chunk.reason.kind === "error") {
			// 模型失败是以 `finish.reason.kind === "error"` 回来的：既不抛异常、也不是 error chunk。
			throw new Error(String(chunk.reason.failure?.message ?? chunk.reason.message ?? "模型返回错误"));
		} else if (t === "error") {
			throw new Error(String(chunk.message ?? chunk.error ?? "stream error"));
		}
	}
	if (out.trim() === "") throw new Error("模型没有返回内容");
	return out.trim();
}

/**
 * 后台结算旁问：LLM 跑完后把结果以一条 `command/done` 事件（复用 executor 已落盘的
 * `command/run` 配对 id）追加进会话 —— UI 的命令流节点按 commandId 关联 start/update，
 * 事件到达即把节点 outcome 从「受理中」替换成答案。log-only 事件不进模型上下文，
 * 「不进历史 / 不打断当前轮」两条性质不变。
 *
 * 为什么不复用 handler 的返回值：命令面 `execute()` 会 await handler 完整跑完才结算，
 * 而 composer 的 SubmitMachine 对斜杠命令停在 `submitting` 相位直到结算回来 —— 同步
 * 等 LLM 会把输入框冻住整个流式时长。所以 handler 立即返回受理成功，答案走旁路。
 */
async function settleAside(llm, session, commandId, agent, question) {
	const settle = (kind, text) => {
		try {
			session.append("command/done", { commandId, kind, ...(text === undefined ? {} : { text }) });
			log(`aside settled kind=${kind} commandId=${commandId}`);
		} catch (error) {
			log(`append command/done failed: ${String(error?.message ?? error)}`);
		}
	};
	try {
		const answer = await ask(llm, agent, question);
		settle("success", answer);
	} catch (error) {
		settle("error", String(error?.message ?? error));
	}
}

export function apply(ctx) {
	const llm = ctx.llm;

	// 直接注册（与官方 goal / feedback 插件同形）。**不要把 register 放进 ctx.effect 的回调里**：
	// 那样注册时机取决于 effect 调度，可能晚于客户端启动时的那一次命令发现。
	// register 自己返回 disposer，拿在手里等卸载时摘掉即可。
	const dispose = ctx.commands.register({
		name: COMMAND_NAME,
		description: "旁问：只根据当前会话回答，答案不进对话历史、不打断当前轮、没有工具",
		input: { hint: "<问题>" },
		handler: async ({ agent, rawInput, commandId }) => {
			const question = String(rawInput ?? "").trim();
			if (question === "") {
				return { kind: "error", text: "用法：/btw <问题>（例如 /btw 刚才那个配置文件叫什么？）" };
			}
			if (llm === undefined || llm === null || typeof llm.stream !== "function") {
				return { kind: "error", text: "llm 服务不可用（未注入 llm）" };
			}
			// 立即受理：composer 的 submitting 相位马上解除，输入框不被 LLM 流时长冻住。
			// 答案由 settleAside 跑完后以 command/done 事件回流渲染。
			// 没有 session.append / commandId 的环境（headless、离线探针直调 definition）退回
			// 同步作答 —— 那里没有 UI 流节点，同步返回是唯一通道。
			const session = agent?.session;
			if (session !== undefined && session !== null && typeof session.append === "function" && typeof commandId === "string" && commandId !== "") {
				void settleAside(llm, session, commandId, agent, question);
				return { kind: "success", text: "旁问已受理，正在后台作答…" };
			}
			// 抛出的异常由命令面结算成 { kind: "error", text }，不必自己包一层。
			const answer = await ask(llm, agent, question);
			return { kind: "success", text: answer };
		},
	});
	log(`command /${COMMAND_NAME} registered; disposer=${typeof dispose}`);
	if (typeof dispose === "function") ctx.effect(() => dispose, "dsh-btw: command dispose");

	log(`host half mounted; command=/${COMMAND_NAME}`);
}
