import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// First: takes the access token out of the launcher link (#/assist?k=...) before anything reads the URL or calls the API.
import './access';
import { App } from './App';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
