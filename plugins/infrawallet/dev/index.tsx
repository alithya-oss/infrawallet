import { createDevApp } from '@backstage/dev-utils';
import { InfraWalletPage, infraWalletPlugin } from '../src/plugin';

createDevApp()
  .registerPlugin(infraWalletPlugin)
  .addPage({
    element: <InfraWalletPage />,
    title: 'Root Page',
    path: '/infrawallet',
  })
  .render();
