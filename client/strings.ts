/**
 * Every user-visible string in the plugin, and the ONLY place Chinese text may live.
 *
 * Identifiers are data and pass through unchanged: agent ids, run ids, commit shas, file paths,
 * provider names, and protocol words such as `dispatched` and `ExitPlanMode`.
 *
 * Two display-layer translators live here because the server's warning and action-result sentences
 * are data the client cannot rewrite (server and shared contracts are frozen for LEG 4). Known
 * templates become Chinese; an unknown sentence passes through unchanged rather than inventing a
 * meaning. Adding a server sentence means adding one case here.
 */

export const S = {
  common: {
    steward: "总管",
    workers: "工人",
    none: "无",
    unknown: "未知",
    ellipsis: "…",
  },

  app: {
    screenTitle: "总管",
    sidebarTitle: "总管",
    panelTitle: "总管",
    commandTitle: "打开总管面板",
    /** Command-palette search terms: Chinese for the owner, English for the protocol's own words. */
    commandKeywords: [
      "steward",
      "总管",
      "wave",
      "批次",
      "leg",
      "legs",
      "pipeline",
      "流水线",
      "lease",
      "租约",
      "slots",
      "槽位",
      "workers",
      "工人",
      "hand over",
      "接管",
    ],
    slashDescription: "查看总管：是否在线、手下有哪些工人在跑、有什么在等你回话",
  },

  screen: {
    discovering: "正在发现项目…",
    noProject: "未发现项目",
    reading: "读取中…",
    notOnboarded: "这个项目没有 control/COMMAND.md，尚无总管接管，暂无需要监督的内容。",
    lastTick: (at: string, result: string) => `上次插件巡检 ${at}：${result}`,
  },

  panel: {
    resolving: "正在解析项目…",
  },

  pill: {
    title: "总管：是否在线，手下有几个工人在跑",
    unreadable: "读取失败",
    handingOver: "正在接管…",
    handOverNow: "立即接管",
    open: "打开总管",
    /** Shown instead of the button when takeover is impossible: no workspace, or supervision is off. */
    handoverOff: "此项目还不能接管：需要先设置总管工作区，并开启巡检（懒人模式）。",
    lazyOff: "懒人模式 · 关",
    lazyOn: "懒人模式 · 开",
    lazyBusy: "正在切换…",
    lazyHintOff: "关闭：不会自动启动总管。只有你按“立即接管”才会开始。",
    lazyHintOn: "开启：工人一完工就叫醒同一个总管会话，它验收后自己派下一步。只有大方向变动才会问你。",
    lazyNoWorkspace: "先指定总管工作区，懒人模式才能开启。",
    /** Loading is not an answer: before the config arrives, say nothing about the workspace. */
    lazyLoading: "正在读取设置…",
  },

  sections: {
    waiting: (n?: number) => (n === undefined ? "等你回话" : `等你回话（${n}）`),
    currentBatch: "当前批次",
    warnings: (n?: number) => (n === undefined ? "警告" : `警告（${n}）`),
    lease: "租约",
    capacity: "容量与权限",
    acceptance: "验收（Gate）",
    acceptanceNote: "读的是 checks/out 里的产物，不是一句话；门通过不等于评审通过",
    pending: (n: string) => `待处理请求（${n}）`,
    automaticAnswers: "自动答复",
    automaticAnswersNote: "每次自动答复尝试均有记录，最新在前。发送尝试不代表请求已答复",
    history: "历史",
    historyNote: "过去的记录，不是当前状态",
  },

  facts: {
    state: "状态",
    session: "会话",
    since: "起始",
    heartbeat: "心跳",
    lease: "租约",
    worktreeSlots: "工作树槽位",
    solverFork: "求解分支",
    project: "项目",
    lazy: "懒人模式",
    planExit: "计划退出",
    questions: "提问",
    shell: "命令",
    anythingElse: "其他请求",
    lastRun: "最近一次运行",
  },

  values: {
    heartbeatFuture: "在未来：时钟不准",
    heartbeatDetail: (ago: string) => `${ago}（心跳只说明多新，不说明在不在）`,
    noLease: "control/COMMAND.md 中没有租约",
    acceptanceUnverified: "无产物：implemented, unverified",
    acceptanceLegacyAccepted: "已验收（早于产物留档，产物未保存）",
    acceptanceNoArtifactShort: "产物未留档",
    acceptanceLegacyArtifact: "旧格式产物：未复核",
    acceptanceMismatch: (sha: string) => `产物 sha ${sha} 不是当前 HEAD`,
    acceptanceCommandsFailed: "产物记录的验收命令未全部退出 0",
    acceptanceReady: "accepted by gate, review pending",
    slotsUsed: (used: number, cap: number) => `已用 ${used} / ${cap}`,
    forkDirty: (n: number) => `${n} 个未提交文件：有分支任务正在写入`,
    clean: "干净",
    gitDetail: (dirty: number, ahead: number, behind: number) => `${dirty} 个未提交 · 领先 ${ahead} · 落后 ${behind}`,
    lazyOn: "开：无人自动推进",
    lazyOff: "关：只在你按下时动",
    intoWorkspace: (workspace: string) => `在 ${workspace} 中运行`,
    noWorkspace: "未设置总管工作区",
    planExitAllowed: "自动放行",
    planExitOff: "关闭：等你处理",
    planExitDetail: "仅限 ExitPlanMode。Claude 随后进入 acceptEdits，与按下 Implement 相同",
    questionsDeclined: "自动拒答",
    questionsOff: "关闭：等你处理",
    questionsDetail: "会告知代理结束回合，把问题写进报告",
    anythingElseValue: "一律等你处理",
    anythingElseDetail: "shell 命令、写文件、授权",
    pendingNone: "无",
    pendingUnreadable: "无法读取 paseo permit ls",
    auditNone: "暂无",
    lastRunNone: "无",
    lastRunDetail: (exit: number, rows: number) => `退出码 ${exit} · 台账 ${rows} 条`,
    merged: (leg: string) => `已合并 ${leg}`,
    ledgerLine: (n: number) => `台账仍把 ${n} 条记为 dispatched`,
    ledgerNote: "记录，不是实时",
    pendingTrailing: (kind: string, status: string, name: string) => `${kind} · 代理 ${status} · ${name}`,
    auditText: (decision: string, request: string, agentId: string) => `${decision} ${request} · ${agentId}`,
    auditTrailing: (at: string, source: string, failed: string | null, title: string) =>
      `${at} · ${source}${failed ? ` · ${failed}` : ""} · ${title}`,
    auditFailed: (error: string) => `失败：${error}`,
    auditNotRecorded: (error: string) => `审计未记录：${error}。未保存意图时不会发送；未保存的结果暂存在插件内存，读取时重试保存`,
    auditStatus: (delivery: string, recorded: boolean, error: string | null) => {
      const status = delivery === "confirmed" ? "已确认请求结束（重新读取代理状态）"
        : delivery === "unconfirmed" ? "已尝试发送，未确认送达或答复，可重试"
        : delivery === "prepared" ? "已保存意图，未确认发送或答复，可重试"
        : delivery === "not-sent" ? "未发送：保存意图失败，可重试"
        : delivery === "failed" ? "发送失败，可重试" : "旧记录，答复结果未确认";
      return `${recorded ? "已记录" : "未记录"} · ${status}${error ? ` · ${error}` : ""}`;
    },
    auditRetention: (r: { totalCap: number; projectCap: number; retained: number; evicted: number; lastEvictedAt: string | null }) =>
      `全部项目合计最多保存 ${r.totalCap} 条；每项目最多 ${r.projectCap} 条，当前保留 ${r.retained} 条均在此显示。超过上限淘汰最旧记录。本版开始累计淘汰 ${r.evicted} 条${r.lastEvictedAt ? `，最近淘汰于 ${r.lastEvictedAt}` : ""}；更早的淘汰数量未知，已淘汰记录不可恢复`,
  },

  actions: {
    handOverNow: "立即接管",
    refresh: "刷新",
    lazyChip: (on: boolean) => (on ? "懒人模式：开" : "懒人模式：关"),
    planChip: (on: boolean) => (on ? "计划退出：放行" : "计划退出：等你"),
    questionChip: (on: boolean) => (on ? "提问：拒答" : "提问：等你"),
    shellChip: (on: boolean) => (on ? "命令：放行" : "命令：等你"),
    answerPending: "按策略处理",
    archiveStray: "归档多余工作区",
    onboard: "接入这个项目",
  },

  status: {
    loading: { label: "读取中", detail: "正在读取项目" },
    noSteward: { label: "无总管", detail: "control/COMMAND.md 中没有租约" },
    notOnboarded: { label: "无总管", detail: "项目尚未接入（缺少 control/COMMAND.md）" },
    clock: { label: "时钟异常", detail: "心跳在未来，说明写心跳时的时钟不对" },
    unreadable: { label: "无法确认", detail: "读不到 agent 列表（paseo CLI 不可用），不能断定主管不在" },
    /** No agent named in the lease: the project genuinely has no steward, and 接管 will start one. */
    unclaimed: { label: "无主管", detail: "租约里没有认领的 agent，将自动接管" },
    /** The lease names an agent that Paseo no longer has — also a real absence. */
    gone: { label: "主管已不在", detail: (id: string) => `租约认领 \`${id}\`，但 Paseo 里没有这个 agent` },
    alive: "在岗",
    aliveBusy: "在岗 · 在派活",
    aliveDetail: (ago: string, id: string) => `${id ? `认领 ${id}` : "已认领"} · 心跳 ${ago}`,
    agoUnknown: "时间未知",
    agoUnderMinute: "不到一分钟前",
    agoMinutes: (n: number) => `${n} 分钟前`,
    agoHours: (n: number) => `${n} 小时前`,
    agoDays: (n: number) => `${n} 天前`,
    workers: (n: number) => (n === 0 ? "无人在跑" : `${n} 个在跑`),
    pill: (n: number) => (n <= 0 ? "总管" : `总管 · ${n > 99 ? "99+" : n}`),
  },

  /**
   * The progress bar. A "leg" is shown to the owner as 任务. "估算" is the one qualifier for a guessed
   * denominator and must stay a single word: the compact form has room for exactly one.
   */
  progress: {
    title: "进度",
    estimated: "估算",
    milestones: "里程碑",
    done: "完成",
    blockedWord: "阻塞",
    questionsWord: "待答",
    staleWord: "停滞",
    tallyMilestones: (done: number, total: number) => `里程碑 ${done} / ${total}`,
    tallyLegs: (accepted: number, open: number) => `按任务估算：已验收 ${accepted}，未完成 ${open}`,
    estimatedNote: "plan.md 没有里程碑，分母是任务数，会随拆分和新增而变",
    segment: {
      accepted: "已验收",
      inReview: "待审",
      inFlight: "进行中",
      queued: "排队",
      blocked: "阻塞",
    } as Record<"accepted" | "inReview" | "inFlight" | "queued" | "blocked", string>,
    /** One line of live work, in the order the owner can act on it. */
    current: {
      blocked: (n: number) => `阻塞：${n}`,
      inFlight: (n: number) => `进行中：${n}`,
      queued: (n: number) => `排队：${n}`,
    },
    blocked: (n: number) => `${n} 项阻塞：百分比不代表仍在推进`,
    questions: (n: number) => `${n} 个问题等你回话`,
    stale: (ago: string) => `上次推进在 ${ago}`,
    empty: "暂无可衡量的进度",
    emptyDetail: "plan.md 没有里程碑，也还没有任务",
    emptyWord: "无可衡量",
  },

  a11y: {
    status: (label: string) => `总管：${label}`,
    progress: (percent: string, estimated: boolean, blocked: number, questions: number, stale: string | null) =>
      [
        `进度 ${percent}${estimated ? "，估算值" : ""}`,
        blocked > 0 ? `${blocked} 项阻塞` : "",
        questions > 0 ? `${questions} 个问题等你回话` : "",
        stale ? `上次推进在 ${stale}` : "",
      ]
        .filter(Boolean)
        .join("，"),
    sidebar: (alive: number, total: number, running: number) =>
      `总管 ${alive}/${total} 在线，${running} 个工人在跑`,
  },

  /** The daemon's request kind, and the two audit sources. Values stay data; only the label changes. */
  kind: (kind: string) => (kind === "plan" ? "计划" : kind === "question" ? "提问" : kind === "other" ? "其他" : kind === "shell" ? "命令" : kind === "external" ? "外部路径" : kind === "temp" ? "临时目录" : kind),
  agentStatus: (status: string) => {
    switch (status) {
      case "idle":
        return "空闲";
      case "running":
        return "运行中";
      case "closed":
        return "已关闭";
      case "error":
        return "出错";
      case "initializing":
        return "初始化中";
      default:
        return status;
    }
  },
  auditSource: (source: string) => (source === "event" ? "事件" : source === "sweep" ? "按需" : source),
  decision: (decision: string) => (decision === "allow" ? "已放行" : decision === "deny" ? "已拒答" : decision),
  auditDecision: (decision: string) => (decision === "allow" ? "放行意图" : decision === "deny" ? "拒答意图" : decision),
};

/**
 * Server warnings are sentences computed in `server/`, which this leg may not edit. Translate the
 * known templates; an unknown warning is shown verbatim so it cannot silently lose its meaning.
 */
export function warning(text: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^pending completion delivery: (\d+) worker notice\(s\), oldest (.+); failed deliveries for this claim: (\d+)\. (.+)$/.exec(text))) {
    return `待发送完成通知：${m[1]} 条，最早 ${m[2]}；当前接管连续发送失败 ${m[3]} 次。${m[4] === "The wheel will retry even with an empty Ready queue." ? "即使待办队列为空，巡检仍会重试。" : "发送已暂停，等待人手开启懒人模式。"}`;
  }
  if (text === "`paseo agent ls` could not be read, so the live worker count is unknown.") {
    return "无法读取 paseo agent ls，实时工人数未知。";
  }
  if ((m = /^(\d+) agent\(s\) are idle with a pending request \((.+)\) — the turn cannot close and no completion notification will be sent until it is answered\.$/.exec(text))) {
    return `${m[1]} 个代理空闲但仍有待处理请求（${m[2]}）—— 回合无法结束，也不会有完成通知，直到该请求得到答复。`;
  }
  if (text === "`paseo permit ls` could not be read, so pending requests are unknown.") {
    return "无法读取 paseo permit ls，待处理请求未知。";
  }
  if ((m = /^no steward workspace is configured for (.+)\. Pick the one workspace this project's steward may run in \("set-workspace"\); until then the tick cannot start\.$/.exec(text))) {
    return `${m[1]} 尚未设置总管工作区。请选定这个项目总管唯一可运行的工作区（set-workspace）；在此之前巡检无法开始。`;
  }
  if ((m = /^lease heartbeat is in the FUTURE \((.+), age (.+) min\) — a future heartbeat never looks stale, so the handover would silently never happen\. Write it from `date -u`\.$/.exec(text))) {
    return `租约心跳在未来（${m[1]}，${m[2]} 分钟）—— 未来的心跳永远不会显得过期，接管会静默地永不发生。请用 date -u 写入。`;
  }
  if ((m = /^lease looks stale \(state=(.+), age (.+) min\) — a successor may claim it\.$/.exec(text))) {
    return `租约看起来已过期（状态=${m[1]}，${m[2]} 分钟）—— 后继总管可能接管。`;
  }
  if ((m = /^(\d+) extra local workspace\(s\) point at this project \((.+)\) — the steward belongs in (.+) only\. Use "archive-stray"\.$/.exec(text))) {
    return `有 ${m[1]} 个多余本地工作区指向这个项目（${m[2]}）—— 总管只应位于 ${m[3]}。请使用 archive-stray。`;
  }
  if ((m = /^only (\d+) worktree slot\(s\) in use of a cap of (\d+) — count occupied slots before the next dispatch and fill toward three when the graph allows\.$/.exec(text))) {
    return `工作树槽位只用了 ${m[1]} / ${m[2]} —— 下次派发前先数占用槽位，条件允许时补到三个。`;
  }
  if ((m = /^project tree has (\d+) uncommitted file\(s\)\.$/.exec(text))) {
    return `项目树有 ${m[1]} 个未提交文件。`;
  }
  if ((m = /^solver fork has (\d+) uncommitted file\(s\) — a fork leg is mid-write; no other fork writer may start\.$/.exec(text))) {
    return `求解分支有 ${m[1]} 个未提交文件 —— 有分支任务正在写入；其他分支写入者不得开始。`;
  }
  return text;
}

function serverSentence(text: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^(.+?) (.+?) \((plan|question|other|shell|external|temp)\): (allow|deny); (.+)$/.exec(text))) {
    const status = m[5] === "not recorded — answer was not sent" ? "未记录，未发送答复"
      : m[5]!.split("; ").map((part) => part === "recorded" ? "已记录" : part === "not recorded" ? "未记录"
        : part === "confirmed" ? "已确认请求结束" : part === "unconfirmed" ? "已尝试发送，未确认，可重试"
        : part === "failed" ? "发送失败，可重试" : part).join("；");
    return `${m[1]} ${m[2]}（${S.kind(m[3]!)}）：${S.auditDecision(m[4]!)}；${status}`;
  }
  if ((m = /^(.+?) (.+?) \((plan|question|other|shell|external|temp)\): left pending — (.+)$/.exec(text))) {
    const reason = m[4] === "project is not onboarded" ? "项目尚未接入"
      : m[4] === "agent is in no steward project" ? "代理不属于任何总管项目"
      : m[4] === "this policy is off" ? "该策略已关闭"
      : m[4] === "an out-of-project path other than /tmp; the human decides" ? "项目外路径（/tmp 以外），由人决定"
      : m[4] === "not a plan exit, a question, a shell command or /tmp scratch; the human decides"
        ? "不是计划退出、提问、shell 命令或 /tmp 临时写入，由人决定"
      : null;
    if (reason !== null) return `${m[1]} ${m[2]}（${S.kind(m[3]!)}）：仍待处理，${reason}`;
  }
  if (text === "project is required for this action") return "需要指定项目";
  if (text === "Invalid steward config: projects must be an array") return "总管配置无效：项目列表必须是数组";
  if (text === "workspace is required") return "需要指定工作区";
  if (text === "intervalMinutes is required") return "需要指定巡检间隔";
  if (text === "set the steward workspace first, otherwise the tick would create a new workspace on every run") {
    return "请先设置总管工作区，否则每次巡检都会新建一个工作区";
  }
  if (text === "no stray steward workspaces") return "没有多余的总管工作区";
  if (text === "no project has the tick enabled") return "没有项目开启巡检";
  if (text === "no result") return "没有结果";
  if (text === "nothing pending") return "没有待处理请求";
  if (text === "policy and on are required") return "需要指定策略和开关";
  if (text === "answer-pending needs the daemon's Paseo client") return "按策略处理需要守护进程的 Paseo 客户端";
  if (text === "onboard needs a folder path in `project`") return "接入需要一个文件夹路径（project）";
  if ((m = /^refused onboard (.+?): (.+)$/.exec(text))) return `拒绝接入 ${m[1]}：${m[2]}`;
  if ((m = /^onboarded (.+?): all 7 gates pass \((.+)\)(?: — (.+))?$/.exec(text))) {
    return `${m[1]} 已接入：七道门全过（${m[2]}）${m[3] ? ` — ${m[3]}` : ""}`;
  }
  if ((m = /^onboard (.+?): (\d+)\/(\d+) gates pass(?:; open: (.+?))?(?: — (.+))?$/.exec(text))) {
    return `${m[1]}：七道门通过 ${m[2]}/${m[3]}${m[4] ? `；未过：${m[4]}` : ""}${m[5] ? ` — ${m[5]}` : ""}`;
  }
  if ((m = /^unknown action (.+)$/.exec(text))) return `未知操作 ${m[1]}`;
  if ((m = /^unknown project (.+)$/.exec(text))) return `未知项目 ${m[1]}`;
  if ((m = /^forgot (.+)$/.exec(text))) return `已移除 ${m[1]}`;
  if ((m = /^(.+?) steward workspace set to (.+)$/.exec(text))) return `${m[1]} 的总管工作区已设为 ${m[2]}`;
  if ((m = /^(.+?) interval set to (\d+) min$/.exec(text))) return `${m[1]} 的巡检间隔已设为 ${m[2]} 分钟`;
  if ((m = /^(.+?) tick (enabled|disabled)$/.exec(text))) return `${m[1]} 巡检已${m[2] === "enabled" ? "开启" : "关闭"}`;
  if ((m = /^(.+?): lazy mode (on|off)$/.exec(text))) return `${m[1]} 的懒人模式已${m[2] === "on" ? "开启" : "关闭"}`;
  if (text === "set the steward workspace first — lazy mode would otherwise create a new workspace on every dispatch") {
    return "请先设置总管工作区，否则每次派发都会新建一个工作区";
  }
  if ((m = /^(.+?): (allow plan exit|deny questions) (on|off)$/.exec(text))) {
    const policy = m[2] === "allow plan exit" ? "计划退出放行" : "提问拒答";
    return `${m[1]}：${policy}已${m[3] === "on" ? "开启" : "关闭"}`;
  }
  if ((m = /^archived (.+)$/.exec(text))) return `已归档 ${m[1]}`;
  if ((m = /^(.+?): dispatched into (.+)$/.exec(text))) return `${m[1]}：已派发到 ${m[2]}`;
  if ((m = /^(.+?): failed — (.+)$/.exec(text))) return `${m[1]}：失败 — ${m[2]}`;
  if ((m = /^(.+?): skipped — unknown project$/.exec(text))) return `${m[1]}：已跳过 — 未知项目`;
  if ((m = /^(.+?): skipped — no steward workspace configured$/.exec(text))) return `${m[1]}：已跳过 — 未设置总管工作区`;
  if ((m = /^(.+?): skipped — lease is live \((.+), age (.+) min\)$/.exec(text))) {
    return `${m[1]}：已跳过 — 租约仍有效（${m[2]}，${m[3]} 分钟）`;
  }
  if ((m = /^(.+?): skipped — hand-over is off or not onboarded$/.exec(text))) {
    return `${m[1]}：已跳过 — 巡检已关闭或项目未接入`;
  }
  return text;
}

/** A control result or tick result. The server joins several sentences with ` · `. */
export function serverMessage(text: string): string {
  return text.split(" · ").map(serverSentence).join(" · ");
}
