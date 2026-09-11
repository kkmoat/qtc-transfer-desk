export type DirectoryLink = { label: string; href: string; sponsored?: boolean; action?: 'wechat' };
export type DirectoryCategory = { id: string; title: string; links: readonly DirectoryLink[] };

const OTC_ORDERS_URL = 'https://docs.google.com/spreadsheets/d/1o7pVtQ-YKB0HHFsvPjXqkae1F0yCP4FxaxbNgBkkfU8/edit?usp=sharing';

export const DIRECTORY_CATEGORIES: readonly DirectoryCategory[] = [
  {
    id: 'quantus', title: 'Quantus', links: [
      { label: 'Quantus官网', href: 'https://www.quantus.com/' },
      { label: '项目介绍', href: '/intro/' },
      { label: '官方钱包', href: 'https://www.quantus.com/wallet/' },
      { label: '区块浏览器', href: 'https://explorer.quantus.com/' },
      { label: '官方Github', href: 'https://github.com/Quantus-Network' },
    ],
  },
  {
    id: 'markets', title: '行情', links: [
      { label: 'QTC总览', href: '/overview/' },
      { label: '场外OTC订单', href: OTC_ORDERS_URL },
      { label: 'QTC网站挂单', href: OTC_ORDERS_URL },
    ],
  },
  {
    id: 'trading', title: '交易', links: [
      { label: '币安返手续费注册', href: 'https://www.bi86.com/go/8.html', sponsored: true },
      { label: 'QTC转账', href: '/transfer/' },
      { label: '加密账户QTC找回', href: '/encrypted/' },
    ],
  },
  {
    id: 'mining', title: '挖矿', links: [
      { label: 'Quantus挖矿指南', href: 'https://docs.quantus.com/guides/mining/' },
      { label: '挖矿成本计算器', href: '/mining/' },
      { label: '视频教程', href: 'https://youtu.be/4PxgKMTHiOA?si=Hyq_3Oc7AN3bdVq7' },
      { label: '文字教程', href: 'https://decisive-savory-c10.notion.site/Quantus-Vast-3d6a1811fe6880c5ab1ef195516f2134' },
      { label: 'quanpool', href: 'https://quanpool.com/' },
    ],
  },
  {
    id: 'learning', title: '学习', links: [
      { label: 'Quantus白皮书', href: 'https://www.quantus.com/whitepaper/' },
      { label: '官方文档', href: 'https://docs.quantus.com/' },
      { label: '比特币入门', href: 'https://bitcoin.org/zh_CN/' },
    ],
  },
  {
    id: 'community', title: '社区', links: [
      { label: '中文交流群', href: 'https://t.me/QuantusCN' },
      { label: '微信交流群', href: '/images/quantus-wechat.jpg', action: 'wechat' },
      { label: '官方X', href: 'https://x.com/QuantusNetwork' },
      { label: '官方Telegram', href: 'https://t.me/quantusnetwork' },
      { label: '作者X', href: 'https://x.com/kkmoat' },
      { label: 'Quantus研究论坛', href: 'https://research.quantus.com/' },
    ],
  },
];
