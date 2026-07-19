import { createRoot } from 'react-dom/client';
import { createElement } from 'react';

createRoot(document.getElementById('root')).render(
  createElement('p', { 'data-fixture': 'stack-certification' }, 'stack-certification')
);
