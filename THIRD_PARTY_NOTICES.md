# 第三方代码与许可证声明

QTC 转账台应用及本项目的 Rust 浏览器适配层采用 **GPL-3.0-only**，见 [LICENSE](LICENSE) 和 [crypto/LICENSE](crypto/LICENSE)。本文件记录主要组成部分，不能替代第三方原始许可证、版权声明或 NOTICE；第三方代码保留各自权利与适用条款。

## Quantus 加密组件

| 组件 | 固定版本 | 上游包声明的许可证 | 本仓库位置 |
| --- | --- | --- | --- |
| qp-rusty-crystals-dilithium | 4.1.1 | GPL-3.0 | `crypto/vendor/qp-rusty-crystals-dilithium/` |
| qp-rusty-crystals-hdwallet | 4.1.1 | GPL-3.0 | `crypto/vendor/qp-rusty-crystals-hdwallet/` |
| qp-poseidon-core | 3.1.0 | MIT-0 | `crypto/vendor/qp-poseidon-core/` |
| wasm-bindgen | 0.2.114 | MIT OR Apache-2.0 | `crypto/vendor/wasm-bindgen/` |
| zeroize | 1.8.2 | Apache-2.0 OR MIT | `crypto/vendor/zeroize/` |
| blake2 | 0.10.6 | MIT OR Apache-2.0 | `crypto/vendor/blake2/` |
| bs58 | 0.5.1 | MIT/Apache-2.0（上游标注） | `crypto/vendor/bs58/` |

准确的直接依赖声明在 [crypto/Cargo.toml](crypto/Cargo.toml)，完整依赖版本由 [crypto/Cargo.lock](crypto/Cargo.lock) 固定。`crypto/vendor/` 包含对应 Rust 依赖的源码及随包提供的许可证、版权和声明文件；例如其余依赖还使用 CC0-1.0、BSD-3-Clause、Unicode-3.0、Zlib 等许可证，应一并保留这些文件。

公开浏览器资产位于 `public/crypto/`，包含项目的 Worker、WASM 和 wasm-bindgen 生成的 JavaScript 接口。对应的适配层源码、构建参数、锁文件、vendor 与测试位于 [crypto/](crypto/)，同一份源码还通过 `public/source/quantus-browser-crypto-source.zip` 提供下载。重建方法见 [crypto/REBUILD.md](crypto/REBUILD.md)。公开或再分发这些文件时，应保留对应源码和许可证的获取途径。

这是基于官方原语编写的独立适配层，不是 Quantus 官方发布或背书的浏览器钱包。提供源码与校验和不等同于安全审计或已经验证逐字节可复现构建。

## 前端与构建依赖

以下为本次锁文件中的主要直接依赖。具体版本、间接依赖和许可证元数据以 [package-lock.json](package-lock.json) 及安装后各包的原始 LICENSE/NOTICE 为准。

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| @polkadot/types | 16.5.6 | Apache-2.0 |
| @polkadot/util-crypto | 14.0.3 | Apache-2.0 |
| React / React DOM | 19.2.6 | MIT |
| radix-ui | 1.6.7 | MIT |
| lucide-react | 1.31.0 | ISC |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| tailwind-merge | 3.6.0 | MIT |
| Vite | 8.2.2 | MIT |
| @vitejs/plugin-react | 6.0.2 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| Tailwind CSS / @tailwindcss/postcss | 4.2.1 | MIT |
| tw-animate-css | 1.4.0 | MIT |

页面组件包含基于 shadcn/ui 的代码。相关 Tailwind 样式及其 MIT 声明保存在 `vendor/shadcn-tailwind-4.13.0.css` 与 `vendor/shadcn-tailwind-4.13.0.LICENSE.md`，原声明为 Copyright (c) 2023 shadcn。修改或分发时请保留该声明。

运行依赖通过 npm 的锁文件安装，不将 `node_modules/` 作为源码仓库的一部分提交。构建工具和 Rust 工具链属于另外安装的软件，其许可证不因本项目的许可证而改变。

## 协议参考与测试资料

本项目根据 Quantus 公开的协议和实现核对派生、签名及交易格式，参考包括：

- [Quantus-Network/quantus-apps](https://github.com/Quantus-Network/quantus-apps)；核对的提交为 `76df7b06d7a092c9cdfb9a459f8effb9ddb5e737`。
- [Quantus-Network/chain](https://github.com/Quantus-Network/chain)；核对的提交为 `f1176cea6a6d08ea437710dcd45cae6717b773df`。

测试包含官方公开测试向量和公开主网元数据。公开测试助记词仅用于可重复测试，不能当作安全的钱包凭据，也不应持有资金。该类 fixture 不代表真实用户的个人交易记录。

Quantus、QTC 与第三方项目名称在此用于说明兼容性和来源。列出第三方项目不表示其维护者认可、支持或审计过本工具。
