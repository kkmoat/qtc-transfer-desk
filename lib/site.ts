export const SITE_ORIGIN = 'https://qtc123.com';
export const SITE_NAME = 'QTC123';
export const VIEWS = ['directory', 'intro', 'overview', 'transfer', 'encrypted', 'mining', 'holders', 'pool'] as const;
export type DeskView = typeof VIEWS[number];
export const viewPath = (view: DeskView) => view === 'directory' ? '/' : `/${view}/`;
export const canonicalUrl = (view: DeskView) => SITE_ORIGIN + viewPath(view);

export function viewFromPath(pathname: string): DeskView | undefined {
  if (pathname === '/') return 'directory';
  return VIEWS.find(view => view !== 'directory' && (pathname === viewPath(view) || pathname === `/${view}`));
}

export function viewFromLocation(pathname: string, hash = ''): DeskView {
  return VIEWS.find(view => hash === `#${view}`) ?? viewFromPath(pathname) ?? 'directory';
}

const metadata = {
  directory: {
    zh: { title: 'QTC币导航-Quantus_QTC币交易所_QTC币价格_QTC钱包', description: 'QTC币导航提供Quantus量子加密区块链最新资讯，QTC币交易所大全，QTC币钱包下载，QTC币最新价格行情,Quantus 是量子安全加密货币。QTC币供应上限 2,100 万，保护隐私。' },
    en: { title: 'QTC123 | Quantus Directory & QTC Tools', description: 'An independent Quantus community directory with official resources, wallets, explorers and crypto links, plus QTC overview, transfers, encrypted accounts and mining cost tools.' },
  },
  intro: {
    zh: { title: 'Quantus（QTC）项目介绍与技术资料｜QTC123', description: '了解 Quantus 与原生币 QTC，阅读后量子密码学、QPoW 工作量证明和 Wormhole 加密账户的中文介绍，并直达官方白皮书、文档与开源代码。' },
    en: { title: 'Quantus (QTC) Introduction & Resources | QTC123', description: 'Explore Quantus and QTC, post-quantum signatures, QPoW and Wormhole encrypted accounts, with links to the official whitepaper, documentation and source code.' },
  },
  overview: {
    zh: { title: 'QTC 总览：价格、供应与市值参考｜QTC123', description: '查看 Quantus 主网发行量、流通量估算和 QTC 市值参考，了解 SafeTrade 的 QUANTUS/USDT 报价、24 小时行情及数据来源。' },
    en: { title: 'QTC Price, Supply & Market Cap Overview | QTC123', description: 'View Quantus mainnet supply, estimated circulation and market cap references, with SafeTrade QUANTUS/USDT quotes, 24-hour market data and source details.' },
  },
  transfer: {
    zh: { title: 'QTC 主网转账与余额查询｜QTC123', description: '查询 Quantus 普通账户余额，在浏览器中本地签名并提交 QTC 转账；确认收款地址、金额和费用，查询交易状态与本地转账记录。' },
    en: { title: 'QTC Mainnet Transfers & Balance Lookup | QTC123', description: 'Check Quantus account balances and sign QTC transfers locally in your browser. Review recipients, amounts and fees, and track transaction status and local receipts.' },
  },
  encrypted: {
    zh: { title: 'Quantus 加密账户查询与转出｜QTC123', description: '恢复和扫描 Quantus Wormhole 加密账户，查看收款地址与余额，核对费用后转出到本人普通账户。零知识证明在本机生成。' },
    en: { title: 'Quantus Encrypted Accounts & Withdrawals | QTC123', description: 'Restore and scan Quantus Wormhole encrypted accounts, view receiving addresses and balances, and withdraw to your own normal account with locally generated proofs.' },
  },
  mining: {
    zh: { title: 'QTC 挖矿成本与收益估算计算器｜QTC123', description: '根据 Quanpool 公开数据、设备算力、租金或电费，估算 QTC 产量和每枚挖矿成本；输入预期币价模拟收入与盈亏，查看计算依据。' },
    en: { title: 'QTC Mining Cost & Profitability Calculator | QTC123', description: 'Estimate QTC output and cost per coin using Quanpool public data, hashrate, rental or electricity costs. Model revenue and profit with your own price assumptions.' },
  },
  holders: {
    zh: { title: 'QTC 持币地址与账户余额排行｜QTC123', description: '查看 Quantus 主网持币地址，按可用 QTC 余额从高到低排列，显示冻结余额、预留余额、账户总数和官方区块浏览器数据来源。' },
    en: { title: 'QTC Holder Addresses & Account Balances | QTC123', description: 'Browse Quantus Mainnet holder addresses by available QTC balance, with frozen and reserved balances, account totals, and data from the official explorer API.' },
  },
  pool: {
    zh: { title: 'QTC 矿池实时算力与 Quanpool 数据｜QTC123', description: '查看 Quanpool 的 QTC 近 1 小时矿池算力、全网估算算力、矿池占比、幸运值、当前轮次、活跃矿工、矿机数量和矿工算力排行。' },
    en: { title: 'QTC Live Pool Hashrate & Quanpool Data | QTC123', description: 'View Quanpool QTC pool hashrate, estimated network hashrate, pool share, luck, round effort, active miners, workers, and the 1-hour miner ranking.' },
  },
} as const;

export const pageMetadata = (view: DeskView, language: 'zh' | 'en' = 'zh') => metadata[view][language];
