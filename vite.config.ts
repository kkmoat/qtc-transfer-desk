import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath,URL} from 'node:url';
import {META_CSP} from './scripts/security-policy.mjs';

export default defineConfig({
 plugins:[react(),{
  name:'production-security-policy',
  transformIndexHtml:{order:'post',handler(html,context){
   if(context.server)return html;
   return [{tag:'meta',attrs:{'http-equiv':'Content-Security-Policy',content:META_CSP},injectTo:'head-prepend'}];
  }},
 }],
 resolve:{alias:{'@':fileURLToPath(new URL('.',import.meta.url))}},
 envPrefix:'QTC_PUBLIC_UNUSED_',
 server:{host:'127.0.0.1',port:5173},
 build:{target:'es2022',sourcemap:false,outDir:'dist',emptyOutDir:true},
});
