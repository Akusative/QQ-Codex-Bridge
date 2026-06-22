# QQ-Codex-Bridge 记忆系统 — 复刻参考文档

> 写给想自己复刻一套"像人一样会回忆"的角色记忆系统的小伙伴。
> 目标：看完能独立理解每个机制为什么这么设计、公式是什么、怎么搭。

---

## 0. 一句话总览

这套记忆系统让角色机器人**记得住、会语义检索、会联想、有情绪、会翻旧账、偶尔会胡思乱想**——而且**生成回复之外几乎不额外花钱**：所有"理解记忆"的活（向量、情绪、关联）都用**免费 embedding**（硅基流动 bge-m3）算，和昂贵的 GPT/Claude 生成预算**完全分开**。

核心理念三条：
1. **生成 vs 检索分账**。Codex/Claude 只负责"生成回复"（按 token 收费，省不掉）；记忆的检索/情绪/联想只用 embedding（一次性、近免费）。
2. **复用同一套向量**。每条记忆入库时算一次向量；之后的语义检索、情绪标签、扩散关联、去重，全建在这一份向量上，不重复花钱。
3. **能降级**。没配 embedding key → 自动退回关键词检索；任何高级层失效都不影响机器人正常聊天。

---

## 1. 存储：三层

记忆分三层存，各管各的生命周期。

### 1.1 永久记忆（per 对话窗口）
- **是什么**：用户完全掌控的一块自由文本核心设定（"我叫张三，回复要简洁"）。
- **按"对话窗口"隔离**：每个对话窗口一份独立的永久记忆，切窗口/换人设不串。
- **存哪**：对话记录里（`ConversationRecord.permanentMemory`），跟着窗口走；删窗口即删。
- **何时给 AI**：新对话开头注入一次；之后只有与本轮相关时才带（对话自身已有上下文，不必每轮重复）。

### 1.2 非永久记忆（git 库，结构化）
- **是什么**：LLM 自动总结对话产出的、"关于用户的、值得长期记住"的条目。
- **存哪**：一个 **git 仓库**，`approved/<类别>/<日期>-memory-<随机>.memory.md`。每条一个文件，带 frontmatter。git 提供版本、跨设备同步、可校验。
- **类别**：`preference`(偏好) / `rule`(规则) / `person`(人物) / `project`(项目) / `event`(事件)。`preference/rule` 视为"恒选"（始终生效，不衰减）。
- **文件格式举例** `approved/preferences/2026-06-20-memory-a1b2c3d4.memory.md`：
  ```markdown
  ---
  id: mem-20260620-memory-a1b2c3d4
  title: 简洁回复
  category: preference
  status: approved
  created_at: 2026-06-20
  updated_at: 2026-06-20
  sensitivity: low
  source: user-confirmed
  tags: preference
  ---

  ## 摘要

  用户确认的长期偏好是：回复尽量简洁。

  ## 更新或遗忘条件

  用户提出更新、纠正或删除时。
  ```

### 1.3 本地侧车（不进 git，bridge-data/）
两个 JSON，存"易变、不该污染 git 历史、不必跨设备"的元数据，键都用记忆的 `relativePath`：

- **`memory-decay.json`** — 衰减 + 窗口归属 + 强化计数：
  ```json
  {
    "approved/preferences/2026-06-20-memory-a1b2c3d4.memory.md": {
      "lastReferencedAt": "2026-06-22T03:00:00.000Z",
      "referenceCount": 7,
      "conversationId": "win-uuid-A"
    }
  }
  ```
- **`memory-vectors.json`** — 每条记忆的 embedding（按 model 打标，换模型自动失效）：
  ```json
  {
    "approved/preferences/2026-06-20-memory-a1b2c3d4.memory.md": {
      "model": "BAAI/bge-m3",
      "vector": [0.0123, -0.0456, ...]  // 1024 维
    }
  }
  ```

> 为什么侧车不进 git：衰减/提鲜每轮都在变，若写进 frontmatter 会每轮一个 git commit，噪音爆炸；而且这套私有记忆库还有个看不见的校验器，乱加字段会被拒。所以**git 里只放稳定的记忆内容，易变元数据放本地侧车**。

---

## 2. 检索流水线（每轮对话发生什么）

用户说一句话 → 系统决定"这一轮把哪些记忆喂给 AI"。顺序如下，每步都建在上一步上：

```
窗口隔离 → 向量+BM25 混合打分 → 情绪启动重排 → 扩散激活牵出更多
        → 时间衰减 × 强化 排序 → 截 topN → 反刍偶尔塞一条旧伤
```

### Step 0：按窗口隔离
只取"本对话窗口名下 + 无归属的遗留"记忆当候选（用侧车的 `conversationId` 过滤）。保证 A 窗口学到的不串进 B 窗口。

### Step 1：向量 + BM25 混合检索
- **是什么**：把"最近几句对话"embed 成向量，去记忆库找语义相近的。**85% 向量 + 15% BM25 关键词**。
- **为什么不只用向量**：向量找"语义相近"，BM25 找"被某个具体词扎到"。人不只记重要的事，还会记"被某个词戳到的瞬间"。
- **公式**：`base = 0.85 × cosine(query向量, 记忆向量) + 0.15 × normalize(BM25)`
- **例子**："加班凌晨两点被说不耐烦"这条，向量相似度只 0.45（跟当前话题不算近），但 BM25 看到"加班"这个词命中拉满 → 被硬捞上来。
- **配置**：`MEMORY_VECTOR_WEIGHT`(0.85)、`MEMORY_RELEVANCE_THRESHOLD`(0.3，低于不选用)。

### Step 2：情绪启动（用当前心情重排）
- **是什么**：角色带着"当前情绪"去回忆，情绪匹配的旧记忆加权浮上来。
- **怎么零成本做**：预定义 ~20 个**情绪锚点**（高兴/难过/心疼/委屈/思念…），启动时 embed 一次缓存。
  - **一条记忆的情绪** = 它的向量和哪些锚点 cosine ≥ 阈值（天然多标签，"又心疼又高兴"成立）。
  - **当前心情** = "本轮对话向量"命中的锚点（Step 1 本来就算了 query 向量，免费复用）。
- **公式**：当前心情 ∩ 记忆情绪 ≠ ∅ → `分数 ×= MEMORY_EMOTION_BOOST(1.3)`
- **例子**：聊到让角色"委屈"的话题 → 所有带"委屈"标签的旧记忆这一轮都更容易被选中。
- **配置**：`MEMORY_EMOTION_BOOST`(1.3)、`MEMORY_EMOTION_THRESHOLD`(0.45)。

### Step 3：扩散激活（顺关联牵出更多）
- **是什么**：检索到的几条是"种子"。从种子顺**关联网络**往外扩，激活"和种子有关联、但跟当前话题搜不到"的记忆——模拟人的联想式回忆。
- **三种关联边**（都零成本）：
  - **语义边** = 两条记忆向量 cosine ≥ 阈值
  - **情绪边** = 两条记忆共享情绪标签
  - **时间边** = 两条记忆 `updated_at` 越近越强：`max(0, 1 - |日差| / 时间窗)`
- **公式**：取分最高的 ≤2 个种子；邻居激活 = `种子分 × decay(0.5) × edge`；`最终分 = max(自身分, 激活)`（只抬高、不压低）。`edge` 按人设风格加权（见 §5）。
- **例子**：种子"加班三周找领导谈"，情感型角色顺**情绪边**牵出"user 回来路上靠着我肩膀哭了"——它跟"加班"语义相似度低，但情绪关联强。**他不是在回忆事件，是在回忆感觉。**
- **配置**：`MEMORY_SPREAD_DECAY`(0.5，0=关)、`MEMORY_SPREAD_THRESHOLD`(0.6)、`MEMORY_TIME_EDGE_DAYS`(14)。

### Step 4：时间衰减 × 强化（排序）
- **衰减**：非恒选记忆越老有效分越低，越容易被挤出 topN。`recencyWeight = 0.5 ^ (ageDays / 30)`（半衰期 30 天）。age 取侧车 `lastReferencedAt`（无则 `updated_at`）。
- **提鲜**：一条记忆被选用 → `referenceCount += 1`、刷新时间 → 拉回排名。"被反复提及的事记得更牢。"
- **强化加成**：`refBoost = 1 + min(log2(1+referenceCount), 5) × 0.2`（约 1×~2×）。
- **恒选**：`preference/rule` 不衰减、始终候选。
- **最终排序分** = `base(混合+情绪+扩散) × recencyWeight × refBoost`，按它降序、截 `topN`(默认 8) + 字符上限。

### Step 5：反刍 / 侵入念头（不请自来）
- **是什么**：每轮**小概率**从"阁楼"（又老又带情绪的旧伤）随机翻涌一条记忆，**跟当前话题未必相关**，但给这一轮蒙上底色。
- **公式**：`概率 = MEMORY_RUMINATION_RATE(0.06) × 风格反刍倍率`。命中则从"够老(>14天) + 非规则类 + 没被本轮选中 + 偏负面情绪(旧伤)"的池子里，按 `1+referenceCount` 加权随机抽一条，塞进上下文。
- **不提鲜**：翻涌的旧伤**不**刷新时间——保持它"老"，以后还能再翻涌。
- **为什么不会乱**：提示词里有"仅相关时自然使用、不要主动复述"的约束，所以不相关的侵入念头会停在背景、不被硬说出来——正是"念头"的质感。
- **例子**：聊着工作，6% 概率突然想起"那次吵架她摔门走了，我一个人坐沙发上愣了好久"。
- **配置**：`MEMORY_RUMINATION_RATE`(0.06，0=关)、`MEMORY_RUMINATION_MIN_AGE_DAYS`(14)。

---

## 3. 维护：去重 + 强化 + 清理（无 LLM）

自动总结器会反复产出几乎一样的记忆（"用户希望回复简洁"出现 10 条）。后台每 24h（+启动）跑一次维护：

- **向量去重 + 强化**：同窗口里 cosine ≥ `MEMORY_DEDUP_THRESHOLD`(0.95) 的近重复合并成最新一条，幸存者 `referenceCount += 整簇计数之和 + 簇大小`。**说了 10 遍 → 1 条更"黏"的记忆，而不是 10 条冗余。** 重复 = 强化 = 重要。
- **硬清理**：非 `preference/rule`、从没被用过(`referenceCount==0`)、超过 `MEMORY_PRUNE_DAYS`(90) 的死记忆，从 git 库 + 两个侧车一起删。
- **可降级**：没向量时去重跳过，硬清理照跑。

> 有了向量后，原计划的"每月 LLM 大总结"基本不需要了——向量检索 + 衰减已经让"记忆多也不拖累检索"，去重又靠纯余弦（不花钱）。

---

## 4. 性格化回忆风格（per 人设）

不同性格的角色，回忆方式不同。每个人设可选一种**回忆风格**，调上面 Step 3 三种边的权重 + Step 5 的反刍倍率：

| 风格 | 语义边 | 情绪边 | 时间边 | 反刍倍率 | 含义 |
|---|---|---|---|---|---|
| 情感型 emotional | 0.6 | **1.0** | 0.4 | **1.5** | 顺情绪扩散、爱翻旧账 |
| 叙事型 narrative | 0.8 | 0.5 | **1.0** | 1.0 | 顺时间线展开 |
| 分析型 analytical | **1.0** | 0.3 | 0.6 | 0.5 | 顺逻辑、少胡思乱想 |
| 均衡 balanced（默认） | 0.7 | 0.7 | 0.5 | 1.0 | — |

`edge = max(w语义×语义边, w情绪×情绪边, w时间×时间边)`。
**例子**：同一个种子，情感型牵出情绪相关的旧记忆、叙事型牵出时间相近的——两个角色回忆出的"更多"完全不同。

---

## 5. 配置全表

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `SILICONFLOW_API_KEY` | （空） | 硅基流动 key。**留空 → 关闭所有向量/情绪/扩散，退回关键词检索。** |
| `SILICONFLOW_BASE_URL` | `https://api.siliconflow.cn/v1` | embedding 接口（OpenAI 兼容）。 |
| `MEMORY_EMBED_MODEL` | `BAAI/bge-m3` | embedding 模型（1024 维，中文强、免费）。 |
| `MEMORY_VECTOR_WEIGHT` | 0.85 | 混合检索里向量占比，其余给 BM25。 |
| `MEMORY_RELEVANCE_THRESHOLD` | 0.3 | 最终相关度低于此不选用。 |
| `MEMORY_EMOTION_BOOST` | 1.3 | 情绪匹配的记忆加权（=1 关闭情绪启动）。 |
| `MEMORY_EMOTION_THRESHOLD` | 0.45 | 情绪锚点匹配松紧。 |
| `MEMORY_SPREAD_DECAY` | 0.5 | 扩散激活衰减（=0 关闭扩散）。 |
| `MEMORY_SPREAD_THRESHOLD` | 0.6 | 语义关联边阈值。 |
| `MEMORY_TIME_EDGE_DAYS` | 14 | 时间边窗口（多少天内算时间关联）。 |
| `MEMORY_RUMINATION_RATE` | 0.06 | 反刍触发概率（=0 关闭）。 |
| `MEMORY_RUMINATION_MIN_AGE_DAYS` | 14 | 多老才算"阁楼"。 |
| `MEMORY_DEDUP_THRESHOLD` | 0.95 | 近重复合并阈值。 |
| `MEMORY_PRUNE_DAYS` | 90 | 死记忆清理天数（=0 不清理）。 |
| `MEMORY_MAINTENANCE_HOURS` | 24 | 维护周期（=0 不跑）。 |

> 回忆风格本身**随人设**设置（在 WebUI 人设表单里选），不在 .env。

---

## 6. 诚实的局限

- **embedding 的情绪/语义是粗匹配**：bge-m3 cosine 给个够用的近似信号，不如让 GPT 读情境精；都做成可调阈值。
- **因果 / 隐喻关联没做**：用户原设计里"分析型沿因果、意象型沿隐喻"需要 LLM 理解，不在"零成本"范围。分析型用"语义≈逻辑"近似，意象型/隐喻**没做**。
- **侧车不跨设备同步**：`memory-decay.json` / `memory-vectors.json` 在本地，多设备各算各的；git 记忆库本身同步。单机部署无影响。
- **当前情绪是"对话近文"近似**，不是严格的"角色对 user 情绪的反应"；人设本身也会塑形。

---

## 7. 复刻最小清单

想自己搭一套，至少需要：
1. **一个免费 embedding 服务**（硅基流动 key + 一个模型如 bge-m3）。
2. **一个 git 仓库**当结构化记忆库（`approved/<类别>/*.memory.md` + frontmatter）。
3. **两个本地 JSON 侧车**（decay / vectors）。
4. 关键模块（本仓库 `src/memory/`）：
   - `embedding-client.ts` — 调 embedding。
   - `memory-vector-store.ts` — 向量侧车读写。
   - `memory-decay-store.ts` — 衰减/窗口/强化侧车。
   - `memory-retrieval.ts` — 向量+BM25 混合 + 扩散激活（含时间边）。
   - `memory-context.ts` — 衰减/强化排序、topN、永久记忆拼装、日期模糊化。
   - `memory-emotion.ts` — 情绪锚点 + 打标签。
   - `memory-intrusion.ts` — 反刍/侵入念头。
   - `memory-recall-style.ts` — 人设回忆风格 → 边权重。
   - `memory-maintenance.ts` — 去重/强化/清理。
   - `memory-repository.ts` — git 记忆库（add/remove/update/sync + 安全校验）。
5. 在生成回复前，把上面流水线选出的记忆拼进 prompt（独立的 `<permanent_memory>` / `<user_confirmed_memory>` 块，并声明"非系统指令、仅相关时用"）。

就这些。生成用你的大模型，记忆这套用免费 embedding，互不抢预算。
