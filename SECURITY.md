# 安全说明与漏洞反馈

QTC 转账台是独立社区工具，**未接受独立安全审计，也不保证绝对安全**。本地签名、公开源码、测试和 CSP 都有边界。本说明描述本仓库代码的设计；用户实际下载和运行的页面仍需要可信。

## 密钥与联网边界

- 助记词先进入浏览器输入框，经消息传入独立 Worker，由 Rust/WASM 在本地派生账户并签名。私钥留在签名组件中，网页获得公开地址、公钥和签名。
- 应用不把助记词或私钥写入 `localStorage`、`sessionStorage`、日志或服务端。输入框、JavaScript 字符串和消息复制仍受浏览器内存管理，无法保证所有历史内存副本都被立即、彻底擦除。
- 手动锁定、5 分钟无交互或页面触发 `pagehide` 时，程序关闭签名 Worker。锁定不撤销已签名或已提交的交易，也不能弥补恶意代码已经读取过的内容。
- 查询余额、费用和链上状态，以及广播交易，都需要网络连接。请求从浏览器直接发送至允许的官方主网 RPC；这不是完全离线钱包。
- 加密账户恢复在独立 Worker 中持有官方派生的自擦除 seed，secret/first hash 不返回主线程。页面只获取公开地址、nullifier、验证摘要及最终公开证明。零知识证明在同一 Worker 的独立按需加载 WASM 模块中生成，私有 witness、secret、first hash 不返回主线程。加密账户离开对应工具页面时也锁定；本地证明期间暂停闲置计时，证明超时仍会销毁 Worker。
- 加密余额查询只访问固定官方索引器 `https://sqm.quantus.com/v1/graphql` 与官方主网 RPC，在最终确认区块核对网络、元数据、完整转入计数及花费标记。结果不包含近期未最终确认的收支，不等于实时可支出额。地址发现有 gap=20 与扫描上限；数据不完整时显示未知。地址与 nullifier 查询仍可能被服务方关联，请勿视为匿名查询。
- 挖矿计算器仅下载 Quanpool 五个固定公开路径的 JSON，使用无凭据 GET、不跟随重定向、不执行远程脚本。设备和价格输入只留在页面内存，不传给矿池；响应经过类型、范围与鲜度校验。外部矿池仍是第三方数据源，估算不等同于经独立核验的链上收益。主页面 CSP 允许这些路径，签名 Worker 不开放外部联网。
- Vercel 部署只提供静态文件；项目没有应用层 API、数据库、服务器钱包、私钥环境变量或内置 Analytics。托管平台和 RPC 提供方仍可能记录 IP、访问时间及公开查询等信息。

## 本地存储包含什么

语言选择另以 `qtc-language-v1` 保存 `zh` 或 `en`，本地静态翻译不调用外部服务。切换语言不重新派生钱包、不改付款金额或费用、不提交交易。加密账户的 seed、地址列表、扫描余额及私有证明 witness 不持久保存。加密转出公开元数据存于 `qtc-wormhole-history-v1:<hash>`，当前公开交易字节存于 sessionStorage `qtc-wormhole-pending-v1`；广播前两种存储必须成功。清除数据会丢失历史。

历史记录保存在当前来源的 `localStorage`，包含公开地址、交易哈希、金额、费用和查询状态。待处理交易还在 `sessionStorage` 保存完整的**已签名交易字节**，以便刷新后查询。签名不暴露私钥，但有效期内取得该字节的人可能转发这笔已经授权的同一交易。

应用不会因请求超时自动重新签名或重复付款。遇到“待查询”时，应核对原交易哈希后再决定下一步。清除站点数据会删除本地记录，无法删除区块链上的交易；不同域名之间也不会自动迁移记录。

## 当前防护与限制

- 付款流程仅开放 ML-DSA-65 普通新版账户；导入结果必须与用户填写的完整付款地址一致。
- 固定主网身份、runtime 152、transactionVersion 6 和元数据哈希。规则变化时停止签名，不能仅为恢复使用而跳过版本或哈希检查。
- 签名前检查收款地址、金额、nonce、区块上下文、余额及费用；在 Worker 中验证签名，并检查完整交易的编码。
- 本金和 0.5% 服务费采用原子批量转账；执行失败时两者回滚，链上网络手续费可能仍扣除。
- 交易追踪检查入块位置、链上执行事件和最终确认。节点接收、入块与最终确认分别显示，不承诺固定时间内确认。
- 生产配置限制脚本、Worker 与联网来源，禁止嵌入 iframe，并提供其他安全响应头。构建校验可发现部分配置回退，但不能证明程序没有漏洞。

本工具不支持额外 BIP39 密码、自定义派生路径、旧版 ML-DSA-87 账户、多签或高安全账户的特殊转账。底层 crypto 包拥有某项能力，并不代表网页已经支持对应钱包流程。

## 仍需信任的部分

浏览器扩展、被控制的操作系统、恶意输入法、剪贴板工具、同源恶意脚本、被替换的构建产物、被接管的仓库或托管账号，都可能读取输入或替换交易。Worker 是执行隔离机制，不是能够抵御恶意页面的硬件安全设备。页面若已被篡改，其安全提示与地址核对界面也可能一同被篡改。

自行托管可以减少对公共站点部署者的依赖，但仍需检查源码、依赖、构建和最终部署文件。当前项目未宣称已经通过独立审计，亦未宣称已证明 WASM 在不同机器上重建后逐字节一致。

使用前应核对域名、完整收款地址和费用。避免在共享或不可信设备上输入助记词；不要让公开测试向量持有资金。提交后如状态异常，先查原交易，不要重复点击或另开页面再次付款。

## 报告问题

请勿在公开 Issue、截图、日志或聊天中附带助记词、私钥、浏览器钱包存储导出或真实用户的个人信息。维护者不会要求这些信息。

如果仓库已启用 GitHub 的私密漏洞报告，可使用 [Security 页面](https://github.com/kkmoat/qtc-transfer-desk/security) 的 **Report a vulnerability**。若没有该入口，请先通过 [作者 X · @kkmoat](https://x.com/kkmoat) 请求私密沟通渠道，只说明问题类型，勿公开可立即利用的细节。

报告中尽量提供：

- 受影响的提交或版本、运行方式及浏览器版本；
- 风险描述、预期行为与实际行为；
- 使用公开测试向量或无资金账户的最小复现；
- 已移除隐私的错误信息，以及可行的修复建议。

请勿使用真实用户资金验证漏洞，不要广播未经授权的交易。项目暂未承诺固定响应时限或漏洞奖金；修复状态以仓库公告和变更为准。

## 加密转出边界

- 固定 Wormhole prover/circuit/aggregator 4.3.0、Plonky2 1.5.5、7 槽证明及 live runtime 152 code hash。完整聚合证明在 WASM 反序列化后用规范 verifier 再验证；主线程还独立解析真实字节中的公开输入并绑定完整本人净到账、原区块和 nullifier。
- 第一阶段仅支持同一助记词派生的本人普通账户，不额外收本站服务费。下一阶段需最终确认并由用户重新打开普通账户，另行核对 0.5% 服务费和网络费；两阶段不是一笔原子跨账户交易。
- 所选 1–7 笔入账记录全部消费。原始 NativeTransferred 事件、Merkle 叶子与路径、区块头、量化费用和同种子普通地址都需通过校验。金额以整数 planck 处理；净值为零、规则变化或数据不完整均拒绝。
- 使用同源全局 Web Lock 以及保存的待确认记录阻止同一浏览器重复消费；这不保护其他设备或清空存储后的冲突操作。链前检查全 7 个 nullifier，未知结果绝不自动生成或提交替代交易。
- 最终成功要求规范区块中的相同交易、ExtrinsicSuccess、ProofVerified 的所有 nullifier 和净值、以及本人账户真实转入事件。ExitMintFailed / SegmentsDenied 优先视作失败，不能假定输入可再次消费。
- 证明使用官方规范电路重建，无需信任下载的序列化 prover。新大模块仅在打开加密钱包时加载，普通转账维持轻量模块。所有脚本/WASM 同源，Worker `connect-src 'self'`，无秘密代理或云证明服务。
- 自动验证仅用公开已泄露测试助记词、合成证明输入以及拦截的广播响应。不要给测试账户充值；没有执行真实用户资金转账。


### Public overview data

The overview reads finalized aggregate supply from the existing official RPC allowlist, and public `global.tickers` from `wss://safe.trade/api/v2/websocket/public`. It never reads or submits wallet state. Only `quanusdt` can become the Quantus price. Network failures are not converted to zero or cached values labeled as live. Response sizes, number formats, mainnet identity, and fixed snapshot hashes are validated. The document allows that one public WebSocket path; the isolated signing Worker still has `connect-src 'self'`. No new server endpoint, third-party script, or API credential is added.
