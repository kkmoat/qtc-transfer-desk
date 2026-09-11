export type DirectoryLink = { label: string; href: string };
export type DirectoryCategory = { id: string; title: string; links: readonly DirectoryLink[] };

export const DIRECTORY_CATEGORIES: readonly DirectoryCategory[] = [
  {
    id: 'quantus', title: 'Quantus', links: [
      { label: 'Quantus 官网', href: 'https://www.quantus.com/' },
      { label: '项目介绍', href: '/intro/' },
      { label: '官方钱包', href: 'https://www.quantus.com/wallet/' },
      { label: '区块浏览器', href: 'https://explorer.quantus.com/' },
      { label: '项目白皮书', href: 'https://www.quantus.com/whitepaper/' },
      { label: '官方文档', href: 'https://docs.quantus.com/' },
      { label: '官方 GitHub', href: 'https://github.com/Quantus-Network' },
      { label: 'QTC 总览', href: '/overview/' },
    ],
  },
  {
    id: 'markets', title: '行情', links: [
      { label: 'QTC 总览', href: '/overview/' },
      { label: 'CoinGecko', href: 'https://www.coingecko.com/' },
      { label: 'CoinMarketCap', href: 'https://coinmarketcap.com/' },
      { label: 'TradingView', href: 'https://www.tradingview.com/' },
      { label: 'DefiLlama', href: 'https://defillama.com/' },
      { label: 'CoinGlass', href: 'https://www.coinglass.com/' },
      { label: 'DEX Screener', href: 'https://dexscreener.com/' },
    ],
  },
  {
    id: 'trading', title: '交易', links: [
      { label: '币安官网', href: 'https://www.binance.com/' },
      { label: 'OKX', href: 'https://www.okx.com/' },
      { label: 'Coinbase', href: 'https://www.coinbase.com/' },
      { label: 'Kraken', href: 'https://www.kraken.com/' },
      { label: 'QTC 转账', href: '/transfer/' },
      { label: '加密账户', href: '/encrypted/' },
    ],
  },
  {
    id: 'mining', title: '挖矿', links: [
      { label: 'Quantus 挖矿指南', href: 'https://docs.quantus.com/guides/mining/' },
      { label: '挖矿成本计算器', href: '/mining/' },
      { label: 'MiningPoolStats', href: 'https://miningpoolstats.stream/' },
      { label: 'WhatToMine', href: 'https://whattomine.com/' },
      { label: 'F2Pool 鱼池', href: 'https://www.f2pool.com/' },
      { label: 'ViaBTC', href: 'https://www.viabtc.com/' },
      { label: 'Braiins', href: 'https://braiins.com/' },
    ],
  },
  {
    id: 'learning', title: '学习', links: [
      { label: '比特币入门', href: 'https://bitcoin.org/zh_CN/' },
      { label: '以太坊中文', href: 'https://ethereum.org/zh/' },
      { label: '币安学院', href: 'https://www.binance.com/zh-CN/academy' },
      { label: 'Coinbase Learn', href: 'https://www.coinbase.com/learn' },
      { label: '项目白皮书', href: 'https://www.quantus.com/whitepaper/' },
      { label: '官方文档', href: 'https://docs.quantus.com/' },
    ],
  },
  {
    id: 'community', title: '社区', links: [
      { label: '官方 X', href: 'https://x.com/QuantusNetwork' },
      { label: '官方 Telegram', href: 'https://t.me/quantusnetwork' },
      { label: '中文交流群', href: 'https://t.me/QuantusCN' },
      { label: '作者 X', href: 'https://x.com/kkmoat' },
      { label: 'Quantus 研究论坛', href: 'https://research.quantus.com/' },
      { label: 'BitcoinTalk', href: 'https://bitcointalk.org/' },
      { label: 'Ethereum Research', href: 'https://ethresear.ch/' },
    ],
  },
];
