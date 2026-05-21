import {
  configApiRef,
  createApiFactory,
  createFrontendPlugin,
  identityApiRef,
  ApiBlueprint,
  PageBlueprint,
  fetchApiRef,
} from '@backstage/frontend-plugin-api';

import {
  createPlugin,
  createRoutableExtension,
  createComponentExtension,
  createRouteRef,
} from '@backstage/core-plugin-api';

import { rootRouteRef } from './routes';

import { infraWalletApiRef } from './api/InfraWalletApi';
import { InfraWalletApiClient } from './api/InfraWalletApiClient';
import { InfraWalletIcon } from './components';

export const page = PageBlueprint.make({
  params: {
    path: '/infrawallet',
    title: 'InfraWallet',
    icon: <InfraWalletIcon />,
    routeRef: rootRouteRef,
    loader: () => import('./components/Router').then(m => <m.Router />),
  },
});

export const api = ApiBlueprint.make({
  params: defineParams =>
    defineParams(
      createApiFactory({
        api: infraWalletApiRef,
        deps: {
          identityApi: identityApiRef,
          configApi: configApiRef,
          fetchApi: fetchApiRef,
        },
        factory: ({ identityApi, configApi, fetchApi }) => new InfraWalletApiClient({ identityApi, configApi, fetchApi }),
      }),
    ),
});

export const infrawalletPlugin = createFrontendPlugin({
  pluginId: 'infrawallet',
  extensions: [page, api],
  routes: {
    root: rootRouteRef,
  },
});

/**
 * Legacy plugin for old frontend system compatibility
 * @deprecated Use infrawalletPlugin for the new frontend system
 */
export const legacyRootRouteRef = createRouteRef({
  id: 'infrawallet.root',
});

/**
 * Legacy plugin for old frontend system compatibility
 * @deprecated Use infrawalletPlugin for the new frontend system
 */
export const infraWalletPlugin = createPlugin({
  id: 'infrawallet',
  routes: {
    root: legacyRootRouteRef,
  },
  apis: [
    createApiFactory({
      api: infraWalletApiRef,
      deps: { identityApi: identityApiRef, configApi: configApiRef, fetchApi: fetchApiRef },
      factory: ({ identityApi, configApi, fetchApi }) => new InfraWalletApiClient({ identityApi, configApi, fetchApi }),
    }),
  ],
});

/**
 * Legacy routable extension for old frontend system compatibility
 * @deprecated Use infrawalletPlugin for the new frontend system
 */
export const InfraWalletPage = infraWalletPlugin.provide(
  createRoutableExtension({
    name: 'InfraWalletPage',
    component: () => import('./components/Router').then(m => m.Router),
    mountPoint: legacyRootRouteRef,
  }),
);

/**
 * Legacy component extension for old frontend system compatibility
 * @deprecated Use infrawalletPlugin for the new frontend system
 */
export const EntityInfraWalletCard = infraWalletPlugin.provide(
  createComponentExtension({
    name: 'EntityInfraWalletCard',
    component: {
      lazy: () => import('./components/EntityInfraWalletCard').then(m => m.EntityInfraWalletCard),
    },
  }),
);
