# 支付验收客户端

第二周新增报价校验、单次付费请求、持久化 nonce 记录和只读回执核验，并提供对应测试。
本轮没有部署这些新增功能，也没有执行真实付款。模拟签名、模拟 RPC 和测试结果均不能作为实付证明；
当前 Passport 与 Kite 支付网络的兼容问题仍待确认，见 [PAID_CALL.md](./PAID_CALL.md)。

## 配置

需要 Node.js 22+，先运行 `npm ci --ignore-scripts`。复制并填写配置：

```sh
cp config/client.example.json config/client.local.json
```

[示例配置](./config/client.example.json)中的 `payer`、`policy.payTo` **故意使用零地址**，
必须换成付款人的 EOA 地址和已独立确认的服务收款地址，否则校验失败。

| 字段 | 含义 |
| --- | --- |
| `policy.url` | 已确认的 HTTPS 地址，路径必须精确为 `/v1/memory/audit`，不能含凭据、查询或片段 |
| `policy.network` | `testnet` 或 `mainnet`；不是被审计的 Sepolia 网络 |
| `policy.payTo` | 独立确认的收款地址，不能照抄未知服务返回的地址 |
| `policy.maxAmount` | 原子单位的十进制整数字符串；测试网 pieUSD 的 `1000000000000000` 等于 `0.001 pieUSD` |
| `payer` | 签名所属的非零 EOA 地址 |
| `receiptRpcUrl` | 用户独立配置的支付链 RPC，不能来自商户返回值 |
| `journalDirectory` | 持久化付款尝试目录，默认 `.payment-attempts`；同一付款钱包的调用保持使用同一目录 |

目前只接受可恢复付款人地址的 **65 字节 EOA EIP-3009 签名**，不支持 ERC-1271、
ERC-6492、Permit2 或 Passport 智能钱包签名。原有 Passport 步骤不是本客户端已验证的兼容路径。

## 三个命令

### 1. 预检：不签名、不付款

```sh
npm run payment:client -- preflight config/client.local.json examples/request.json evidence/preflight.local.json
```

发送一次未付费 POST，要求服务返回 402。校验唯一报价的资源地址、Kite 网络、代币、
EIP-712 域、收款人、金额上限和授权期限；拒绝扩展付款语义。输出保留报价和本地请求摘要。
预检成功不代表付款成功，也不意味着自动获得钱包授权。

### 2. 执行：使用已获授权的兼容签名

```sh
npm run payment:client -- execute config/client.local.json examples/request.json evidence/authorization.local.json evidence/payment.local.json
```

`authorization.local.json` 必须是兼容钱包/客户端生成的完整 x402 v2 PaymentPayload，
包括 `resource`、`accepted`、`payload.authorization` 和 `payload.signature`，不是单独一段签名。
签名须由调用者授权，并与当前报价一致且尚在有效期内。CLI 不请求或导入私钥，也不代替用户批准钱包操作。

执行时重新预检、恢复签名地址、记录 nonce，随后最多发送一次带签名的请求；不跟随重定向，不自动重试。
授权文件敏感，应保存在被 Git 忽略的 `evidence/*.local.json` 中，不提交或公开。
配置也使用 `config/*.local.json`，避免泄漏 RPC 凭据。

第三周增加自动保存完整报告：`execute` 在付款前预留 `OUTPUT.report/` 私密目录，
完整匹配的 HTTP 200 报告收到后保存 `request.json`、精确正文 `report.json` 和摘要清单，
再核验付款回执。执行结束后保存付款结果白名单摘要；目录已存在或预留失败时不会发送付款。
报告保存失败时仍调查原交易，不自动重付。目录已被 Git 忽略，分享前需检查内容。
完整报告离线复核、目录状态及限制见 [REPORTS.md](./REPORTS.md)。

付款前，CLI 用网络、付款人和 nonce 原子创建持久记录。更换输出文件名不会绕过同一目录内的重复检查。
保留 `.payment-attempts`，不要删除记录、换目录或换新 nonce 来重试未知付款。
它防止同一授权重复发送，**不承诺跨机器或新授权的业务幂等性**。

### 3. 复查：只读，不产生新付款

```sh
npm run payment:client -- verify config/client.local.json evidence/payment.local.json evidence/recheck.local.json
```

使用原执行证据里的 `expectation`，核对原交易的回执、区块归属、代币转账和授权 nonce，
默认至少 2 个确认。若最初没有取得交易引用、证据没有 `expectation`，此命令不能猜测原交易；
应先查明原付款记录。不要用新的付款代替复查。

所有命令都拒绝覆盖已有输出；输入 JSON 文件最大 64 KiB。`execute` 先保留 pending 文件，
发生中断时应连同尝试记录一起检查。结果非成功或参数错误时退出码为 2。

## 程序接入

库接口可接入由 viem 钱包客户端提供的 `address` 与 `signTypedData` 适配器。
签名仍由既有钱包处理，不需要把私钥交给本项目。以下为接口接入示意，变量由调用方提供：

```ts
import { createSignedPayment, executePaidAudit } from './src/paid-client.js';
import { createReceiptRpc } from './src/payment-receipt.js';

const evidence = await executePaidAudit({
  policy,
  request,
  payer: walletSigner.address,
  rpc: createReceiptRpc(receiptRpcUrl),
  sign: quote => createSignedPayment(quote, walletSigner),
  beforeSend: attempt => durableNonceStore.claim(attempt),
});
```

`beforeSend` 必须在发送前完成持久化、原子拒绝重复 nonce；失败时抛错。
CLI 的实现见 [scripts/payment-client.ts](./scripts/payment-client.ts)。
独立调用 `createSignedPayment` 前仍需通过预检执行用户的收款人和预算策略。

## 如何解释结果

- `verified`：`execute` 已核对匹配的链上转账、授权 nonce、HTTP 200 及报告声明。
  `verify` 命令的 `verified` 只表示回执核验通过，不代表报告已交付。
- `unknown`：可能已付款，但响应、确认数、回执或报告不足。继续调查原交易，不自动重付。
- `rejected`：本次执行在发送付款请求前被拒绝；同一授权的历史尝试仍需单独核对。

执行结果 JSON 保存报告摘要、判定及公开付款信息，不保存付款签名或全部响应头。
CLI 另将完整报告保存到私密 `OUTPUT.report/` 目录；库调用方可提供 `captureReport` 回调。
客户端核对的是报告的 subject、指定 block 和 checkpoint 状态/序号声明，没有重新证明记忆内容真实，
执行命令的判定也没有重放报告里的全部证据；第三周新增的 `report:verify` 命令另行完成离线重放。
请求 SHA-256 是本地关联记录，EIP-3009 并未把 HTTP 请求体提交到链上。

独立配置 RPC 有助于分离商户与核验来源，但仍然信任该 RPC；2 个确认不是共识、最终性或收据包含证明。
服务端在结算前限制完整报告为 4,000,000 字节，超限返回 422；客户端同样限制响应大小。
本工具不恢复丢失的报告，也不能消除结算超时的不确定性。
