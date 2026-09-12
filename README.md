# QTC123 · Quantus 中文导航与工具

Quantus 中文社区网址导航，提供项目介绍、QTC 总览、浏览器本地签名转账、加密账户和挖矿成本计算工具。前端由 React、TypeScript 和 Vite 构建，部署产物是静态文件，可自行运行或部署到 Vercel。

本项目是独立社区工具，**不是 Quantus 官方钱包，未经独立安全审计**。开源、本地签名和安全响应头能够帮助审查与降低部分风险，不能保证设备、浏览器、依赖或托管页面绝对安全。使用前请阅读 [安全说明](SECURITY.md)。

- 在线使用：[qtc123.com](https://qtc123.com/)
- 网址导航：[按 Quantus、行情、交易、挖矿、学习和社区分类浏览常用网址](https://qtc123.com/)
- 项目介绍：[Quantus 项目概况、核心技术与官方资料](https://qtc123.com/intro/)
- 外观：右上角可切换白色／深色模式，默认深色；偏好仅保存在本机 `qtc-theme-v1`，刷新和切换页面后保留，存储不可用时仍可在当前页面切换。
- 语言：页面右上角选择 **中文 / English**，偏好仅保存在本机 `qtc-language-v1`，切换不会改变账户、金额或服务费。
- 加密账户：[Encrypted Account 恢复与转出](https://qtc123.com/encrypted/)
- 挖矿计算：[设备算力与每枚 QTC 成本](https://qtc123.com/mining/)
- 源码：[github.com/kkmoat/qtc-transfer-desk](https://github.com/kkmoat/qtc-transfer-desk)
- 作者：[X · @kkmoat](https://x.com/kkmoat)
- 链上查询：[Quantus 区块浏览器](https://explorer.quantus.com/)

## 支持范围

- 查询 Quantus 主网公开地址的余额，不需要助记词。
- 按多种显卡与数量或实测总算力，结合租金／电费、设备摊销和自设 QTC 单价，估算净产量、每枚成本及盈亏。
- 使用 **ML-DSA-65 新版普通账户**，在本地派生地址、签名并核对签名。
- 将到账金额和额外的 0.5% 服务费放入同一笔 `Utility.batch_all`，两笔转账一起成功或一起回滚。
- 提交后按原交易哈希查询入块、执行结果与最终确认；刷新页面可恢复当前域名下保存的交易记录。
- 当前仅支持 **runtime specVersion 152、transactionVersion 6**，并固定主网 genesis 和 metadata 哈希。检测到升级或交易规则变化时拒绝签名，需要更新程序后才能继续转账。

网页不支持 ML-DSA-87 旧账户、额外 BIP39 密码、自定义派生路径、多签或高安全账户的特殊流程。Rust 适配层包含两种签名方案的底层实现和测试，这不表示网页开放了两种方案。

## 如何使用

1. 核对访问的域名与源码来源，也可以按下文在自己的电脑运行。仅查余额时，选择“查询公开地址”，填写完整的 `qz…` 地址即可。
2. 需要付款时，选择“打开已有钱包”。从官方钱包的“接收”页面复制**付款账户自己的完整地址**，填写助记词和账户序号。第一个账户通常为 `0`；程序要求派生出的地址与填写的地址完全相同。
3. 核对账户余额，输入收款地址和对方应收到的 QTC 金额。
4. 查看预览中的付款地址、收款地址、到账金额、服务费、网络手续费及总支出。勾选费用确认后，点击“确认签名并发送”。
5. 等待交易状态更新。“节点已接收”“已入块”和“已最终确认”是不同阶段。发生请求超时或状态不确定时，先按原交易哈希查询，**不要直接重新付款**。
6. 完成后点击“锁定钱包”。连续 5 分钟没有交互，或页面触发 `pagehide`，也会锁定钱包并终止签名 Worker。

不要将助记词发给作者、客服、GitHub Issue 或聊天工具。项目中的公开测试助记词仅用于测试，任何人都能使用，不能向其派生地址存入资金。

## 加密账户（Wormhole）

打开 [加密账户页面](https://qtc123.com/encrypted/)，从官方钱包 **Encrypted Account** 的接收页复制完整地址，再输入同一钱包的助记词。无需填写普通账户序号。助记词只传给本地 Worker，Rust 使用官方 `qp-rusty-crystals-hdwallet 4.1.1` 派生以下两条序列：

- 收款：`m/44'/189189189'/0'/0'/n'`
- 找零：`m/44'/189189189'/0'/1'/n'`

用户同意查询说明后，浏览器向官方 `https://sqm.quantus.com/v1/graphql` 索引器查询派生公开地址的记录，并向官方 RPC 核对相同最终确认区块的 `Wormhole.TransferCount` 与 `UsedNullifiers`。花费标记在本地计算，seed、secret 和 first hash 不返回页面。索引器和 RPC 可关联这些查询及 IP，因此这不是匿名或离线查询。

每个分支发现到连续 **20 个未使用地址**后停止，默认每分支上限 1000 地址，总转入记录上限 10000。缺页、错误网络、索引滞后、未知运行规则或达到扫描上限会报错，不将未知余额显示为 0。派生地址必须包含用户填写的接收地址，才展示恢复结果。

显示的是**所标注最终确认区块上的未花费余额，扣除费用和量化零头之前**，不等于当前可立即支出的金额；近期转入和转出可能尚未反映。官方已确认的自定义大间隔地址不在自动恢复范围内。每次查询都重新核对，不持久缓存地址集合或加密余额。

### 两步转出

1. 恢复并扫描后，填写**本人普通 ML-DSA-65 账户序号**（默认 `0`）。网页用同一助记词在 Worker 内派生并验证收款地址，不接受任意第三方地址。
2. 选择本次消费的 1–7 笔未花费入账记录。所选记录扣费后全部转出，不产生加密找零；其余记录保留。预览列出所选总额、Wormhole 链上费、原始输入零头损失和实际到账。**第一步本站服务费为 0。**
3. 用户明确确认后，在本机生成并验证固定 7 槽聚合零知识证明，仅向官方 RPC 广播一次。证明可能使用约 **1 GB 内存**，建议桌面浏览器并保持页面打开；内存不足、加载失败或超时会锁定钱包，提交前失败不会广播。
4. 网页按原交易哈希核对实际到账事件及最终确认。只有验证成功后才出现第二步入口；不会自动付款。点击后重新输入同一助记词打开本人普通账户，再按现有流程填写收款方并确认 **0.5% 服务费 + 普通网络费**。

当前固定主网 runtime 152 / transaction version 6，额外核对运行时代码 hash `0x4a2d509dfa3faf06a9645bd444d5f2f63ac8ab2f75ba540a0b84680a514514fa`，以及原始入账事件、规范 Merkle 叶子/路径、带 zkTreeRoot 的区块头和完整证明公开输入。任一规则变化会停止转出。

链上 Wormhole 费率为 **4 bps（0.04%）**，但金额按 **0.01 QTC** 量化：逐笔舍去不足量化单位的零头，再对所选总量计算费用并取整。**实际小额费用可能明显超过 0.04%**，以确认页准确金额为准；净到账为零的批次会被拒绝。

只在浏览器保留公开转出记录：`qtc-wormhole-history-v1:<hash>` 保存元数据，`qtc-wormhole-pending-v1` 在当前标签页保存公开广播字节。提交前无法持久保存记录则不广播。刷新后重新验证链上结果，不信任缓存的“成功”状态。结果不明不自动替换证明；同源标签页通过 Web Lock 和待确认记录避免重复提交。其他设备无法共享此锁，请勿重复消费同一批输入。

Wormhole 有效期按当前 `System.BlockHashCount = 4096` 规则核对，不复用普通交易的 64 区块周期。完整有效区间未最终扫描完，不会将未知结果判作过期。`ExitMintFailed` / `SegmentsDenied` 即使伴随 `ExtrinsicSuccess` 也不算成功，部分 nullifier 可能已消耗，需重新核对而非直接重试。

离开加密页面、手动锁定、5 分钟未操作或 `pagehide` 会终止其 Worker；本地证明生成时暂停闲置计时。锁定已提交交易的钱包**不撤销交易**，公开结果查询仍可继续。清除网站数据会丢失本地历史，需要凭交易哈希通过区块浏览器查询。

## English interface

Use **中文 / English** in the top-right corner. Transfers, fee confirmation, history, mining inputs/results, encrypted account recovery, and error messages are translated locally. No translation service is contacted. Only the language preference is saved; switching language does not change form values, wallet identity, or the **0.5%** regular-transfer service fee.

The **Encrypted Account** view restores official Wormhole receiving/change addresses, checks finalized balances, and supports a **two-step withdrawal**. Select up to 7 incoming records and withdraw their complete net value to your own ML-DSA-65 account derived from the same phrase. Step 1 has no site fee; the chain fee and 0.01 QTC quantization losses are shown before confirmation. The local proof can use about 1 GB of memory. After verified finality, re-enter the phrase to open the regular account and separately approve any subsequent transfer (0.5% service fee plus network fee).

Public addresses are queried from the official indexer and spent markers from official RPC; operators may correlate requests with your IP. Phrases, seeds, and private witnesses stay in the local Worker and are not persisted. Only public transaction metadata and the current public broadcast bytes are stored. Unknown results are tracked by their original hash, never automatically replaced. Clearing site data loses local history. Validation uses public test fixtures and mocked broadcast responses; no user-funded transaction is sent as part of automated testing.

## 费用

本工具**额外收取到账金额的 0.5% 作为服务费**，不会从填写的到账金额中减去。服务费收款地址是：

```text
qzp1rKcjGd8WWBiZv5kuWEL1jxHygtABcEgKURMpUwEPimXRV
```

QTC 使用 12 位小数。代码以整数计算服务费：`ceil(到账金额最小单位 / 200)`，仅向上取整至 `0.000000000001 QTC`。例如：

| 对方到账 | 额外服务费 | 预计总支出 |
| --- | --- | --- |
| 0.01 QTC | 0.00005 QTC | 0.01005 QTC + 网络手续费 |
| 1 QTC | 0.005 QTC | 1.005 QTC + 网络手续费 |

网络手续费由 Quantus 链计算，与服务费分开。预览会显示估算值，并为余额检查保留约 10% 的网络费缓冲；缓冲不是额外固定收费，实际扣费以链上结果为准。本金与服务费是同一笔批量交易，区块浏览器可能为两条转账记录重复显示同一个网络费，不能因此将其加算两次。

程序使用 `transfer_keep_alive`，保留当前规则要求的最低账户余额（runtime 152 为 `0.001 QTC`），并检查冻结资金和新收款账户的最低余额。服务费账户尚未激活、且本次服务费不足以创建该账户时会拒绝交易，不会自动提高费率。付款地址不能与上述服务费地址相同；该账户应使用官方钱包等兼容工具付款。

任一笔内部转账失败时，本金和服务费均回滚，但链上网络费仍可能扣除。普通转账成功后，不能通过本工具撤销。

## 挖矿成本计算器

打开 [挖矿成本计算器](https://qtc123.com/mining/)，不需要打开钱包：

1. 选择矿工软件、显卡型号和数量，可添加多种设备；缺少基准的型号可以自定义单卡算力，也可以直接输入所有设备的总算力。
2. 填写在线率。基准默认按原始算力保守扣除矿工软件费；如果填写的是已经扣过矿工费的矿池有效算力，切换为“有效算力”，避免重复扣费。
3. 租用设备填写**所有设备总租金**，选择按日或按小时。租金按每天 24 小时计算，即使在线率较低也不自动减租；已含电费无需重复填写。自有设备填写整套设备运行功率、电价，可另填购置总价和摊销天数。电费按在线时长计算，摊销按自然日计算，其他成本按每日计入。
4. 输入自己预期的 QTC 价格（USD/QTC），查看每日及 30 天收入与盈亏。价格留空仍可计算每枚成本。所有美元输入统一为 **USD**，不自动换汇。

数据直接来自 [Quanpool](https://quanpool.com/) 的固定公开 GET 接口：`/api/terms`（显卡基准、两类费率）、`/api/stats/mainnet`（难度、同步状态和鲜度）、`/api/luck/mainnet`（平均出块时间）、`/api/rounds/mainnet`（最近奖励记录）、`/api/chains`（主网标识）。算力单位为 H/s，奖励整数除以 `10^12` 得到 QTC。全网算力以难度除以平均区块时间推算，不能用矿池自身算力替代。

页面显示每次成功读取时间；计算器打开且页面可见时每分钟刷新。请求错误、字段不符或同步中会显示提示；可短暂保留上次有效快照，但**超过 5 分钟停止估算**。不使用硬编码的旧截图数字冒充实时数据，不执行第三方 JavaScript，不部署数据代理。

```text
日净产量 = 算力份额 × (86400 / 出块秒数) × 区块奖励 × 在线率
           × 矿工费保留比例 × 矿池费保留比例
每 QTC 成本 = 每日总成本 / 日净产量
每日收入 = 日净产量 × 用户输入的 QTC 单价
每日盈亏 = 每日收入 − 每日总成本
```

默认“模拟新增设备”沿用 Quanpool 的 `设备算力 / (全网算力 + 设备算力)`；如果设备已经在挖矿，可选择“已有设备”，使用 `设备算力 / 全网算力`。奖励采用接口返回的最近一条奖励记录，列表为空时使用条款值；确认记录可能晚于最新区块，不代表未来奖励固定。

Quanpool 未标注 GPU 基准的费前／费后口径，因此默认当作费前估算。其原计算器只扣矿池费，本工具的原始算力模式还扣矿工软件费。两费**依次相乘**：例如矿工费 5%、矿池费 1%，保留比例为 `0.95 × 0.99 = 94.05%`。这与本站转账的 0.5% 服务费无关，**使用计算器免费**。

模型是当前数据不变时的估算，不保证收益，也不代表实际到账记录。PPLNS 幸运值、拒绝份额、难度和奖励变化会使结果不同；不自动计入未填写的成本、出售手续费、税费或停机耗电。月度统一按 30 天计算。设备、成本及单价只留在页面内存，切换工具保留当前输入，刷新页面重置；不上传，也不保存到浏览器存储。

## 可抓取页面与 SEO

构建时由 `scripts/prerender.mjs` 渲染同一 React 页面，输出 `/`、`/intro/`、`/overview/`、`/transfer/`、`/encrypted/`、`/mining/` 六个静态页面。无需部署服务端，不运行账户查询或钱包操作。每页只有对应视图的初始公开内容，客户端继续使用原有交互。

`lib/site.ts` 统一维护标准网址和中英文标题、描述；构建同时生成 `robots.txt` 与 `sitemap.xml`。站点地图仅列出 `https://qtc123.com` 下不带片段的标准网址。旧 `#intro` 等链接继续兼容；根网址仍默认网址导航。元信息、静态抓取内容和全部 HTML 的 CSP 检查纳入构建验证。

可将 [站点地图](https://qtc123.com/sitemap.xml) 提交到站点所有者的搜索引擎管理后台；仓库不包含 Search Console 验证凭证。

## 本地运行与检查

使用 **Node.js 24.x** 和 npm，在终端执行：

```bash
git clone https://github.com/kkmoat/qtc-transfer-desk.git
cd qtc-transfer-desk
npm ci --ignore-scripts
npm test
npm run check:crypto
npm run build
npm run preview
```

打开预览命令输出的本机地址。修改界面时可运行 `npm run dev`。正式使用前应检查生产构建和预览；开发服务器不是正式托管配置。

`npm test` 执行本地测试，不广播真实交易。`npm run check:crypto` 校验随仓库提供的加密资产。`npm run build` 包含类型检查、静态构建和构建安全检查，输出目录为 `dist/`。这些检查**不等于独立安全审计，也不证明重新编译的 WASM 与发行文件逐字节一致**。

仅运行导航、总览、转账和计算器等静态功能不需要 API 密钥、服务端钱包或数据库。福袋活动另需下述香港后台服务；任何功能都不需要在服务器配置钱包私钥。

部署完成后，可在仓库 Actions 中手动运行检查并打开 `verify_deployment`，核对生产站点的匿名访问、HTTP 安全响应头和每个静态文件的 SHA-256。也可在完成 `npm run build` 后运行 `node scripts/verify-deployment.mjs`。该检查不导入钱包、不提交交易；它要求线上部署与所选提交一致。

官方 RPC 的连通性与访问来源有关，与本站静态文件校验分开检查：运行 `node scripts/verify-deployment.mjs --rpc-only`，验证当前网络下两个节点对网站来源的跨域预检和公开查询。也可加 `--with-rpc` 一并检查。第三方节点可能对数据中心或某些网络限制请求；本站不会为绕过节点限制而把签名功能移到服务器。

## 当前生产部署

自 2026-09-11 起，`https://qtc123.com` 托管在 AWS Lightsail 香港区域（`ap-east-1`），实例 `qtc123` 的静态 IPv4 为 `18.166.39.21`。生产服务使用 Nginx 和 Let’s Encrypt HTTPS；DNS 仍由 Vercel 托管，旧 Vercel 部署保留为备用。

更新生产网站时，应构建目标提交的完整 `dist/`，发布到服务器 `/var/www/qtc123/releases/` 下的新版本目录，核验文件后原子切换 `/var/www/qtc123/current`，再运行上方的线上部署核验。当前 GitHub Actions 负责检查和构建；仅推送代码或更新 Vercel 不会更新香港生产服务器。

Nginx 配置位于 `/etc/nginx/sites-available/qtc123`、`/etc/nginx/snippets/qtc123-common.conf` 和 `/etc/nginx/conf.d/qtc123-maps.conf`。安全响应头应与 `scripts/security-policy.mjs` 保持一致，尤其是 `/crypto/worker.js` 的独立 CSP；Nginx 不读取 `vercel.json`。证书通过 `/var/www/acme` 的 HTTP 验证自动续期，由 `certbot.timer` 定时检查，续期成功后检查并重载 Nginx。

## Vercel 备用部署参考

1. Fork 本仓库，在 Vercel 中导入自己的 GitHub 仓库。
2. 使用仓库根目录，Framework Preset 选择 **Vite**，Node.js 选择 **24.x**。
3. Install Command 设置为 `npm ci --ignore-scripts`，Build Command 为 `npm run build`，Output Directory 为 `dist`。
4. 不需要添加环境变量、数据库、API 服务或钱包密钥。不要启用 Vercel Analytics、Speed Insights 或注入其他统计脚本；它们不属于本项目的默认部署。
5. 部署后检查域名、HTTPS、页面及 `/crypto/worker.js` 的响应头、签名组件加载和公开地址查询，再核对源码与构建版本。

仓库中的 `vercel.json` 提供 CSP 等安全响应头。自行更换托管平台时，也需要配置相应响应头；单纯复制 HTML 中的配置不能替代全部 HTTP 响应头。Vercel 备用站保持静态托管，不提供福袋 API；香港生产站另外运行福袋登记 API 和数据库。钱包签名始终在浏览器本地执行，项目没有内置 Analytics；托管平台仍可能保留普通访问日志。

每个浏览器站点来源拥有独立存储。旧站点、Vercel 新域名、自定义域名与本机地址之间的历史交易**不会自动迁移或同步**。变更域名不会改变链上余额或交易。

## 邀请推广

转账页和挖矿计算器顶部展示作者提供的邀请推广横幅，标明推广属性、邀请码与目标域名。点击后在新标签页打开 `https://www.bi86.com/go/8.html`，并使用 `sponsored noopener noreferrer`。该横幅只包含本站静态文字与样式，不加载第三方广告脚本、不预连接推广域名、不传递钱包或计算器输入，也不承诺注册优惠或收益。

## 数据流与本地记录

助记词由浏览器表单交给本地 Worker，Rust/WASM 在该 Worker 中派生账户并签名。私钥留在签名组件内存中；应用不将助记词或私钥保存到浏览器存储、发送给 RPC，或上传到托管服务器。网页主线程会接收公开地址、公钥和签名，用于检查及构造交易。

余额查询、费用估算和交易广播需要联网，浏览器直接访问配置的官方 RPC：

- `https://rpc1-mainnet.quantus.com`
- `https://rpc2-mainnet.quantus.com`

挖矿计算器另向 `https://quanpool.com/api/` 下的五个固定公开路径发起无凭据 GET，只下载公开矿池数据，不发送设备配置、价格、地址、助记词或签名。网页 CSP 仅新增这些具体路径，签名 Worker 的策略保持不变。Quanpool 可看到普通网络连接信息（例如 IP）。

RPC 提供方可以看到请求的公开账户、交易及网络连接信息。已签名交易会广播到链上，不是私密数据。

| 存储位置 | 内容与用途 |
| --- | --- |
| Worker/WASM 内存 | 当前打开的钱包密钥；锁定时释放组件并终止 Worker |
| `sessionStorage` | 当前待查询交易及已签名交易字节，帮助同一标签页刷新后恢复 |
| `localStorage` | 交易哈希、公开地址、金额、费用与状态等历史记录，不保存助记词或私钥 |

清除本站点数据（包括 `localStorage`、`sessionStorage`）会移除本地记录，但不会撤销或删除链上交易。只清除普通 HTTP 缓存未必删除这些记录。重新打开后仍可通过区块浏览器查询公开地址或交易哈希。

## 源码与加密组件

```text
app/                    React 页面和样式
lib/quantus/            协议编码、RPC、签名通信、交易追踪和记录
lib/mining/             公开矿池数据校验、算力与成本模型
components/mining-calculator.tsx  挖矿计算器交互
public/crypto/          浏览器 Worker、WASM 与 JavaScript 接口
crypto/                 Rust 适配层、Cargo.lock、完整 vendor 和重建说明
public/source/          可公开下载的 Rust 源码包、许可证和校验清单
scripts/                构建、静态预览与校验工具
tests/                  本地测试、公开测试向量及主网元数据
```

加密适配层使用官方发布的 `qp-rusty-crystals-dilithium 4.1.1`、`qp-rusty-crystals-hdwallet 4.1.1`、`qp-poseidon-core 3.1.0`，配合 `wasm-bindgen 0.2.114`。完整对应源码位于 [crypto/](crypto/)，重建步骤见 [crypto/REBUILD.md](crypto/REBUILD.md)。Rust 工具链与 wasm-bindgen CLI 属于外部构建工具，需要另行安装。

本仓库提供固定依赖、对应源码和资产校验方法；当前发布说明不承诺已完成独立、跨机器、逐字节可复现的 WASM 重建验证。

协议参考：

- [Quantus 官方钱包与 SDK](https://github.com/Quantus-Network/quantus-apps)
- [官方 SDK 签名负载实现（固定提交）](https://github.com/Quantus-Network/quantus-apps/blob/76df7b06d7a092c9cdfb9a459f8effb9ddb5e737/quantus_sdk/lib/src/quantus_signing_payload.dart)
- [Quantus 链实现（固定提交）](https://github.com/Quantus-Network/chain/tree/f1176cea6a6d08ea437710dcd45cae6717b773df)

## 许可证与问题反馈

项目采用 **GPL-3.0-only**，完整文本见 [LICENSE](LICENSE)。第三方代码保留各自的许可证、版权和声明，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `crypto/vendor/`。

普通问题可提交 [GitHub Issue](https://github.com/kkmoat/qtc-transfer-desk/issues)，附上版本、浏览器和去除隐私后的复现步骤。涉及漏洞或敏感信息请先阅读 [SECURITY.md](SECURITY.md)，不要公开助记词、私钥或可被直接利用的攻击细节。


## QTC 总览

打开 [QTC 总览](https://qtc123.com/overview/)，可查看当前流通量估算、流通市值 MC、完全稀释估值 FDV、供应上限、当前净发行量、挖矿净新增，以及 SafeTrade QUANTUS/USDT 公开行情。中英文均可使用，无需打开钱包。

- 最大供应量为 21,000,000 QTC，依据 [Quantus 官方白皮书 v0.4.1](https://www.quantus.com/whitepaper/v0.4.1/)。
- 供应直接读取官方主网 `Balances.TotalIssuance`（u128 小端，12 位小数），固定最终确认区块，验证主网 genesis。创世链上发行量为 5,670,000.001 QTC（含初始化余额）。
- “已挖出 · 净新增”是当前净发行量减去创世发行量，受销毁影响，既不是累计新铸量、累计矿工奖励，也不是流通量。加密账户资金已包含在总发行口径中，不另行加总。
- “当前流通量（估算）”单独显示已发行量扣除未解锁分配后的可流通数量，包含初始流动性及已解锁资金。它不是独立机构认证的自由流通量，也不是交易所可售数量。
- 解锁数量按同一最终确认区块的时间读取并计算 `Vesting.Schedules`，使用[主网解锁模块逻辑](https://github.com/Quantus-Network/chain/blob/f5828f0bd827f476cad299d0b092da128f863f5c/pallets/vesting/src/lib.rs)。扣除的是未解锁数量，已经解锁但未领取的部分计入估算流通。实际主网计划与白皮书简述不完全一致，因此不硬编码扣除 26%；数据异常或未适配的 runtime 版本不生成流通估算。
- MC = 当前流通量估算 × 最近成交价；FDV = 21,000,000 × 最近成交价。均以 USDT 计价，用整数精度计算后四舍五入到分；它们不代表实际可变现金额。缺少行情时不填零，缺少流通量时不计算 MC；旧数据明确标记为非实时。
- [QUANTUS/USDT](https://safetrade.com/exchange/QUANTUS-USDT?type=basic) 是 Quantus 在 SafeTrade 的当前交易对，替代原 QUAN/USDT；**不使用 QTC/USDT（另一项目）**。行情使用 [SafeTrade 官方客户端](https://github.com/safetrade-exchange/example-client) 所示 `global.tickers` 公开推送，只解析 `quantususdt`。价格和成交额以 USDT 计，成交量以 QUANTUS 计。
- 行情卡显著提示“市场深度较小”，展示的是最近成交价，不承诺可成交价格，不把 USDT 直接当 USD。报价获取时间不是实际成交时间。
- 两种数据各自更新；每分钟刷新，仅页面可见且总览打开时请求。读取失败保留明确标记的上次数据，没有数据时显示不可用；不内置演示价格或从其他币种补值。
- 公开行情使用指定的 WebSocket 路径并受生产 CSP 限制。部分网络或交易所访问限制仍可能导致报价不可用，此时提示稍后刷新。总览不提供跳转交易所的按钮。

总览完全在浏览器执行，不新增后端、API 密钥或远程 JavaScript。只在文档 CSP 增加指定的 SafeTrade 公开 WebSocket 路径；签名 Worker 的 CSP、加密组件与转账费率不变。

## 限量福袋与管理后台

- 网址导航打开时读取同源 `/api/lucky-bag/enter`。只有后台已开启且有预留名额的访客才看到福袋。打开后扫码添加 kk 微信、填写完整 Quantus 收款地址和微信号，勾选资料用途说明并提交登记。微信二维码和官方钱包来自现有导航资源。
- 数量与总预算分别设置，例如 **10 袋合计 0.1000 QTC**；奖额随机、每份至少 0.0001 QTC、保留四位小数，合计严格等于预算。预算是活动配置，不会自动从钱包扣款。
- 首批名额先到先得，预留 5 分钟。关闭、离页或过期后，按顺序交给仍在线的等待访客；等待页每 15 秒更新。登记成功才计入已领取。关闭活动立即停止新登记，领完停止发放，已登记记录继续保留。
- 后台 `https://admin.qtc123.com` 与主站分开托管、需要登录。可创建/开关活动，查询提交 IP、时间、地址、微信号、随机金额和处理状态。活动默认关闭。
- 当前按人工流程发奖：核验 kk 微信好友关系 → 标记已核验 → 在官方钱包人工转账 → 将交易哈希录入后台标记已发奖。页面不会自动验证个人微信好友关系或执行转账。
- 管理页面、服务端和部署配置由运营者在私有发布目录单独维护，不包含在这个公开仓库，也不部署到 Vercel。公开仓库只包含首页福袋界面及其同源接口调用。
