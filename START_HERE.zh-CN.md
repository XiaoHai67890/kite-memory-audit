# 从这里开始

这个项目对应 KiteAI 活动的 **第 1 类：x402 付费服务**。

它读取 ERC-8350 公开链上历史，重算更新序号、Transition ID 和状态根，
核对授权轮换与指定检查点，然后提供附区块和交易依据的 JSON 报告。
付款在 Kite 网络结算，示例核验对象在 Ethereum Sepolia；两者明确分开。

## 本地运行

需要 Node.js 22+。进入项目目录后：

```sh
npm ci --ignore-scripts
npm run check
npm run build
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  npm run audit:live -- examples/request.json evidence/my-report.local.json
```

上面只读链上数据，不连接钱包。`evidence/live-sepolia-report.json` 是本次开发
保存的真实只读核验结果，不能当作付费调用凭证。

启动本地 HTTP API：

```sh
AUDIT_MODE=local SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com npm start
```

另开终端调用：

```sh
curl -sS http://127.0.0.1:8080/v1/memory/audit \
  -H 'Content-Type: application/json' --data-binary @examples/request.json
```

## 接入收费和上线

1. 将 `.env.example` 复制为 `.env`，填写收款钱包的**公开地址** `PAY_TO`。
2. 初次部署保持 `KITE_NETWORK=testnet`，填写真实 `PUBLIC_BASE_URL`。
3. 按 README 使用 Docker 或 Node 部署到公网 HTTPS。
4. 用自己的 Kite Passport sandbox Agent 完成一次 pieUSD 付款调用，保存响应和交易哈希。
5. 配置本人 `GITHUB_USERNAME` 后执行 `npm run manifest`，生成通过官方 Schema 的服务清单。
6. 按 `SUBMISSION.md` 整理本周真实 Commit 和证据，再提交活动。

服务器不需要私钥或助记词。账户授权和付款由本人钱包/Passport 完成。
当前没有宣称已公网部署、已真实付款、已推送 GitHub 或已通过活动审核。

## 如何读报告

- `consistent`：提供的链上证据内部一致，仍依赖配置的 RPC 与注册表。
- `inconsistent`：发现明确矛盾，例如状态根或检查点不匹配。
- `inconclusive`：证据不足，不能给出完整结论。

证据齐全且报告发现矛盾，仍属于完成了核验服务；存在任何 `unknown` 检查时，
API 返回 503，不发起服务结算。RPC 超时或缺日志不会被当成核验成功。

这不证明记忆真实、模型实际使用过记忆、数据仍然可用，也不重新执行历史签名策略。
支付结算超时可能存在“链上已付款但响应丢失”的情况；重试前应先核对链上记录。
