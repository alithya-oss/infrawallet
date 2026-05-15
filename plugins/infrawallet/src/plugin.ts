import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  createComponentExtension,
  identityApiRef,
  configApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';

import { rootRouteRef, settingsRouteRef } from './routes';
import { infraWalletApiRef } from './api/InfraWalletApi';
import { InfraWalletApiClient } from './api/InfraWalletApiClient';

export const infraWalletPlugin = createPlugin({
  id: 'infrawallet',
  routes: {
    root: rootRouteRef,
    settings: settingsRouteRef,
  },
  apis: [
    createApiFactory({
      api: infraWalletApiRef,
      deps: { identityApi: identityApiRef, configApi: configApiRef, fetchApi: fetchApiRef },
      factory: ({ identityApi, configApi, fetchApi }) => new InfraWalletApiClient({ identityApi, configApi, fetchApi }),
    }),
  ],
});

export const InfraWalletPage = infraWalletPlugin.provide(
  createRoutableExtension({
    name: 'InfraWalletPage',
    component: () => import('./components/Router').then(m => m.Router),
    mountPoint: rootRouteRef,
  }),
);

export const EntityInfraWalletCard = infraWalletPlugin.provide(
  createComponentExtension({
    name: 'EntityInfraWalletCard',
    component: {
      lazy: () => import('./components/EntityInfraWalletCard').then(m => m.EntityInfraWalletCard),
    },
  }),
);
