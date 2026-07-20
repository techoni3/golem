import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')).render(
  createElement('p', { 'data-fixture': 'stack-certification' }, 'stack-certification')
);
