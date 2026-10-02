# 完整报告保存与离线复核

第三周新增完整报告证据包和 `report:verify` 命令。它在本地重放报告所附的
ERC-8350 历史，检查报告声明是否与重算结果一致；不连接钱包，不请求 RPC，也不产生付款。
公网部署和真实参与者付费调用仍需单独完成。

## 复核一个报告

```sh
npm run report:verify -- config/report-policy.example.json examples/request.json evidence/live-sepolia-report.json evidence/my-verification.local.json
```

参数依次为：可信策略、原请求、完整报告、新的结果文件。输出不能已存在。
示例策略固定了已配置的 Sepolia 注册表、起始区块及预期代码哈希；用于其他注册表时，
先独立审查并配置这些值，不要用待核验报告里的值代替可信策略。

复核包括：

- 严格检查完整报告结构、字段和大小，拒绝未知字段及畸形整数。
- 核对原请求、报告 subject、证据 subject，以及指定的快照区块。
- 对照本地策略检查注册表、历史起始区块与代码哈希。
- 使用原请求的 checkpoint 重放历史事件，重算 Transition ID、状态根、授权轮换与历史连续性。
- 对照报告的 verdict、summary、checkpoint，以及检查项的 id、status、sequence、顺序和重复次数。
  检查项的解释文字不作为证明。

结果中的 `status` 与被审计历史的 `replayVerdict` 是两个维度：

| status | 含义 |
| --- | --- |
| `verified` | 报告声明与本地重算一致，且重放没有未知检查；历史本身仍可能是 `inconsistent` |
| `mismatch` | 报告、请求、可信策略或重算结论之间存在不一致，或报告结构无效 |
| `unknown` | 提供的证据不足以完成复核；不能据此宣称历史完整 |

退出码为 0 表示 `verified`；其他复核结果或输入/文件错误退出 2。错误日志不打印输入正文或文件中的凭据。
策略、请求和清单输入限制为 64 KiB，完整报告限制为 4,000,000 UTF-8 字节；结果文件权限为 `0600`。

## 付费客户端保存的证据包

`payment:client execute` 现在会在输出旁预留一个新目录，例如
`evidence/payment.local.json.report/`，然后再执行付款流程。目录已经存在时，执行会在付款前停止。
目录权限为 `0700`，文件为 `0600`；该目录已被 Git 忽略。

| 文件 | 用途 |
| --- | --- |
| `pending.json` | 永久保留的执行开始记录；单独存在时表示需要调查原执行，不要重新付款 |
| `request.json` | 原请求的规范化副本 |
| `report.json` | 收到的完整报告原始 UTF-8 正文，保留精确字节摘要 |
| `manifest.json` | 文件摘要、大小、资源地址与本地关联限制；存在表示完整报告保存成功 |
| `payment.json` | 执行结束后的付款结果摘要；使用字段白名单，不保存签名或原始响应头 |

报告保存发生在付款回执核验之前，因此收到完整匹配的 HTTP 200 报告但付款回执缺失时，
仍能保存报告以供复核。保存失败时继续检查原交易；结果保持未知，不自动重付。
网络未返回完整报告时，本工具不能恢复丢失的正文。

复核证据包并同时核对清单摘要：

```sh
npm run report:verify -- config/report-policy.example.json evidence/payment.local.json.report/request.json evidence/payment.local.json.report/report.json evidence/replay.local.json evidence/payment.local.json.report/manifest.json
```

清单中的报告摘要核对精确正文，请求摘要核对规范化请求。摘要用于本地关联和检测文件变化，
不是数字签名；能够同时替换清单和全部文件的人可以重新生成摘要。

库调用方可以通过 `executePaidAudit` 的 `captureReport` 回调接入自己的本地存储。
回调只收到原请求、完整报告、摘要和已确认的资源地址，不会收到付款签名或响应头。
回调保存数据不等于报告内容复核通过；复核需另用可信策略运行 `report:verify`。

## 示例与结论范围

`evidence/live-sepolia-report.json` 是 2026-09-23 保留的完整只读报告，用于展示可重放的历史。
第三周新采集的 `evidence/week3-live-sepolia-report.json` 结果为 **inconclusive**：
RPC 日志查询返回空数组，而同一区块的 head 声明已有 5 次更新，无法建立完整历史。
采集明细见 `evidence/week3-live-capture.json`；复核结果见
`evidence/week3-offline-verification.json`，它应保持 `unknown`，而不是误判通过。
这些文件不证明服务已经公开部署，也不是付款凭证。

离线重放复核的是所附证据的内部一致性，使用与服务端相同的审计引擎，
仍依赖采集时的 RPC 和独立审查的注册表配置。它不提供共识、日志包含或最终性证明，
不重验历史交易签名，也不证明原始记忆、模型使用或可用性。
付款核验、报告复核和实际服务交付分别记录；EIP-3009 未将 HTTP 请求体绑定到链上授权。
完整报告可能包含服务提供者的自由文本，分享前应检查内容；默认私密保存不代表自动适合公开。
