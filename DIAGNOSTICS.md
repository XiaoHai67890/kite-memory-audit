# 固定区块的双 RPC 证据诊断

第四周新增 `rpc:diagnose`。它帮助定位 Kite x402 审计服务的上游证据缺失：
在同一已确认高度，分别读取两个 RPC 的注册表状态与日志，再比较两个独立报告。
这是只读运维工具，不连接钱包，不签名，不触发付款，也不修改付费服务的结算顺序。

## 运行

需要 Node.js 22+，配置与原请求文件各不超过 64 KiB。

```sh
SEPOLIA_RPC_PRIMARY=https://ethereum-sepolia-rpc.publicnode.com \
SEPOLIA_RPC_SECONDARY=https://eth-sepolia-testnet.api.pocket.network \
  npm run rpc:diagnose -- config/rpc-diagnostics.example.json examples/request.json evidence/my-diagnostic.local.json
```

参数为独立配置、原请求和**尚不存在的新输出文件**。RPC 地址只从配置指定的环境变量读取，
配置文件保存注册表、起始区块、代码哈希与环境变量名称；不保存 RPC 密钥。
两个源必须使用同一注册表策略，原请求必须与策略匹配。

CLI 只接受 HTTPS RPC，拒绝 URL 用户名、密码和片段，也拒绝仅查询参数不同的同一
host + path。查询参数可能包含供应商密钥，不应直接放在共享终端历史或公开文档中。
不同入口或供应商仍不能证明底层节点独立。

示例入口来自 [PublicNode](https://ethereum.publicnode.com/) 和
[Pocket 官方网络清单](https://docs.pocket.network/developers/supported-chains/)。
目录不保证本次所需的 finalized、历史日志或 EIP-1898 功能；不支持时如实记录不可用。

## 固定高度与比较范围

1. 各源先检查 chainId 并查询 `finalized`，不回退到 `latest`。
2. 未指定 `atBlock` 时，选择两个 finalized 高度的较小值；指定时保持原高度，并要求
   两个源都已确认该高度且不早于配置的注册表起始区块。
3. 各源分别调用原采集器，在选定高度固定区块哈希，核对代码、head、授权状态及事件。
   历史事件区块与采集结束时的快照仍由各自的采集器核对。
4. 分别重放历史并生成完整报告，比较快照区块、head、授权、注册表证据和规范化事件。
   原请求中的 checkpoint 用于两个源的各自重放。

`sources` 保留各自的请求计数、finalized 观察、结果代码和已成功生成的完整报告。
`selectedBlock.number` 是本次共同高度。`comparison` 标记状态差异、各源缺少的事件位置、
以及同一位置但内容不同的事件。日志顺序和十六进制大小写不会制造虚假分歧。
没有生成报告的源保留失败代码；不会复制另一方报告填补它。

## 结果含义

| status | 含义 |
| --- | --- |
| `agree` | 两个完整观察一致，重放没有未知检查；须另看每份报告的 verdict |
| `divergent` | 两份观察有语义差异，包括状态、区块或事件缺失、变化 |
| `inconclusive` | 两份观察相同，但包含未知检查，仍不能建立完整历史 |
| `unavailable` | 至少一个源无法提供所需的观察，不能完成双源比较 |

`agree` **不表示历史一定是 consistent**：两份报告都发现相同矛盾时，也可表示来源一致。
两边日志都为空、head 却声称已有更新时，必须保持 `inconclusive`，不能把共同缺失当成通过。
一边缺日志而另一边完整时，标记分歧和缺失位置，不选“正确供应商”，不拼接日志。

CLI 仅在 `agree` 时退出 0，其余诊断结果或输入/文件错误退出 2。标准输出解释来源一致的
限制；错误输出不打印原配置、请求正文、RPC URL 或供应商异常内容。

## 预算与文件

默认每源最多 128 次 RPC 请求，单次 10 秒、全程 45 秒；初始探测和后续采集共享预算。
请求数记录实际派发量。超时不会自动换源或重试，未完成结果不能被当作完整报告。
配置可调整 `maxRequests`（最多 512）、`requestTimeoutMs`（最多 30 秒）和
`totalTimeoutMs`（最多 120 秒），单次预算不能大于全程预算。
原采集器仍限制每个 RPC 响应大小、日志数量及分页工作量。

输出在联网前以 `wx` 独占创建，权限 `0600`，先写入 pending 记录并同步，再进行诊断。
已有输出、符号链接或被替换的输出路径不会被覆盖；写入失败留下的 pending 或部分文件
需要检查，下一次请使用新路径。最终写回同一个已预留的文件句柄，不重新打开输出路径。
`evidence/*.local.json` 已被 Git 忽略；默认私密文件不代表自动适合公开分享。

## 证据和限制

第三周记录的单 RPC 观察在区块 11830421 读到 head sequence 为 5，却没有任何历史日志。
这次诊断新增真实双源采集记录，见 `evidence/week4-live-diagnostic.json` 与
`evidence/week4-live-capture.json`。2026-10-09（上海时间）的最终代码实测中，两源返回
相同的 finalized 区块 11872534，各尝试 8 次请求，后续采集均为 `RPC_UNAVAILABLE`。
结果为 `unavailable`、退出码 2，未生成历史报告，也未进行历史比较。相同区块观察
不能替代失败的历史采集；捕获记录保存实际时间、实现与输入摘要。

双 RPC 比较仍依赖供应商的返回结果与独立审查的注册表策略。它不是日志包含、共识、
最终性或链上真实性证明；两家可以共享基础设施，也可以共同遗漏数据。
它不证明原始记忆的真实、可用性或模型使用，不重验历史签名，也不证明支付结算。
缺少公网部署和真实参与者付款的验收项目仍需另行完成。
