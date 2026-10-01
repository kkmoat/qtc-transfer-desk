import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import Home from '../app/page';
import '../app/globals.css';
import '../app/theme.css';

createRoot(document.getElementById('root')!).render(<StrictMode><Home/></StrictMode>);
