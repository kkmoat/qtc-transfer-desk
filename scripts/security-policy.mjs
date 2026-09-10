export const RPC_ORIGINS = ['https://rpc1-mainnet.quantus.com','https://rpc2-mainnet.quantus.com'];
export const POOL_READ_URLS = ['terms','stats/mainnet','luck/mainnet','rounds/mainnet','chains'].map(path => 'https://quanpool.com/api/' + path);
export const DOCUMENT_CSP = [
 "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
 "img-src 'self' data:", "font-src 'self'", `connect-src 'self' ${RPC_ORIGINS.join(' ')} ${POOL_READ_URLS.join(' ')} https://sqm.quantus.com/v1/graphql wss://safe.trade/api/v2/websocket/public`,
 "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
export const WORKER_CSP = [
 "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'", "worker-src 'none'",
 "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
// frame-ancestors is supported only as an HTTP header.
export const META_CSP = DOCUMENT_CSP.replace("; frame-ancestors 'none'", '');
export const SECURITY_HEADERS = [
 {key:'Content-Security-Policy',value:DOCUMENT_CSP},
 {key:'X-Frame-Options',value:'DENY'},
 {key:'X-Content-Type-Options',value:'nosniff'},
 {key:'Referrer-Policy',value:'no-referrer'},
 {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=(), payment=()'},
 {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'},
];
