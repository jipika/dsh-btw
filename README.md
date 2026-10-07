<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-btw icon">
</div>

# dsh-btw

给 DeepSeek Harness 一个**原生注册的 `/btw` 斜杠命令**：对齐 Claude Code 的旁问（side question）。

```
/btw 刚才那个配置文件叫什么来着？
```

问一个关于**当前会话**的侧面问题，答案**不进对话历史**、**不打断正在跑的轮次**、**没有工具访问**。

它不是插件自建的浮层：走 DSH 的命令面 `ctx.commands.register()`，由官方适配器直接解析执行。

---

## 三条性质是结构性的，不是靠提示词自律

| 性质 | 为什么成立 |
|---|---|
| **不进对话历史** | handler 不产生 user/assistant 消息；答案以 `command/done` 事件回流，`command/run` / `command/done` 是**仅日志**事件、没有轮次包裹，UI 在**模型历史之外**渲染结算文本 |
| **不打断当前轮（也不冻住输入框）** | handler 立即返回受理成功（composer 的 submitting 相位马上解除，输入框继续可用），旁问转后台执行；答案跑完后由插件把 `command/done` 事件（复用 executor 已落盘的 `command/run` 配对 id）append 进会话，UI 的命令流节点按 `commandId` 关联渲染出答案。headless / 无 `session.append` 环境自动退回同步作答 |
| **无工具访问** | `llm.stream(...)` 单轮请求，messages 里只有文本，**没有注册任何工具** |

代价：只看得到会话里已经出现过的内容（用户消息 + 助手回复正文，忽略 reasoning 与工具细节）。
要它去发现新东西，用子代理。

---

## 结构

```
lib/index.js       host 半边：ctx.commands.register({ name: 'btw', … })
lib/transcript.js  上下文组装：事件 → 对话轮次（+ 磁盘会话文件的兜底读取）
```

**命令契约**（DSH 命令面，已按类型声明核对）：

```ts
ctx.commands.register({          // 返回 disposer
  name: 'btw',                   // 小写，字母/数字/_/-
  description: '…',
  input: { hint: '<问题>' },
  handler: async ({ agent, rawInput, signal }) => {
    // 直接对 agent 运行，不产生 model message
    return { kind: 'success', text: answer }   // 或 { kind: 'error', text }
  },
})
```

- 命令行 = 第 0 字节的斜杠 + 名字 + 空白之后的全部内容作为 `rawInput`；
- handler 抛异常会被命令面结算成 `{ kind: 'error', text }`；
- 无 UI 的演示主干 / ACP 自动化不提供命令面，那里本插件不激活（`inject` 里有 `commands`）。

**上下文数据源（按优先级）**：

1. `agent.session`（官方 `Session`）：`snapshotEvents()` 是**实时**事件（含尚未落盘的步骤）、
   `requestContext()` 直接给出当前 provider/model、`id` 是 `SessionId` —— 零 IO、不依赖磁盘格式；
2. 磁盘会话文件 `$DSH_HOME/sessions/…/session.v4.jsonl.zstd`（多帧 zstd 切帧）—— 只在拿不到 session 视图时兜底。

**模型选择**：`session.requestContext()` → 会话事件里最近用过的 → 最近任意会话 → provider 目录第一个模型。

**上下文预算**：最近 60 条 / 60000 字符 / 单条 6000 字符（`lib/index.js` 的 `TRANSCRIPT_LIMITS`）。

## 用法

| 输入 | 行为 |
|---|---|
| `/btw <问题>` | 结算文本就地显示，不进模型上下文 |
| `/btw`（不带问题） | 返回用法提示 |

两点体验上的事实（实测）：

- 输入 `/` 弹出的菜单里只有**技能 / 上下文**分组，host 命令**不出现在该菜单** —— DSH 的命令是直接解析执行的。
- 答案在 handler 结算后**一次性**出现，不是逐字流式（命令面的模型如此）。

---

## 安装（三件套，已在本机 desktop profile 落地）

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies`：
   `"dsh-btw": "link:../../local-plugins/dsh-btw"`
2. `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾：
   ```yaml
   - insert:
       - id: dsh-btw
         name: 'dsh-btw'
   ```
3. `cd ~/.dsh/profiles/desktop && ~/.dsh/bin/pnpm10 install`

**重启 DSH Desktop 应用**后生效。

## 验证状态

已在克隆 profile 起的真实宿主（`dsh --profile _btwprobe --no-open --port 19587`）与离线探针里验证：

| 项 | 结果 |
|---|---|
| 插件在真实宿主激活 | `[dsh-btw] command /btw registered; disposer=function` |
| 命令定义 | `{ name: 'btw', description: '旁问：…', input: { hint: '<问题>' } }` |
| handler · session 视图分支 | `via=session`，1666 事件 → 32 轮 / 10802 字符，模型取自 `requestContext()` |
| handler · 磁盘兜底分支 | `via=agent.id/file`，同样 32 轮，模型解析为 `deepseek-official/deepseek-flash` |
| handler · 空问题 | `{ kind: 'error', text: '用法：…' }` |
| handler · 模型报错 | 抛出 → 由命令面结算成 error |
| 上下文确实带上会话内容 | 送进模型的消息尾部可见最近几轮对话原文 |

未在自动化里覆盖的一项：**从 Web composer 提交 `/btw` 到命令面**（自动化输入进不了该 composer 的应用状态，连内置 `/goal` 也一样）。这一环由官方适配器负责，需要真人键盘在 GUI 里确认。

## 回滚

删掉 `cordis.patch.yml` 里那个 `- insert:` 块（和 `package.json` 里的依赖行），重启应用。
备份见 `~/.dsh/backups/desktop-before-btw-20260930-151014/`。

## 已知边界

- 会话文件 > 32MB 时兜底路径放弃读取（`transcript.js` 的 `MAX_FILE_BYTES`）；session 视图不受此限。
- 答案按纯文本结算，不做 Markdown 排版。
- 没有 Claude 那套 `f`（分叉成子代理）/ `c`（复制原始 Markdown）/ 历史答案翻页。
