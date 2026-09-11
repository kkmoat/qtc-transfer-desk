import { renderToString } from 'react-dom/server';
import Home from '../app/page';
import type { DeskView } from '../lib/site';

// Build-time rendering only. Effects, RPC queries and wallet operations never run.
export const render = (view: DeskView) => renderToString(<Home initialView={view}/>);
