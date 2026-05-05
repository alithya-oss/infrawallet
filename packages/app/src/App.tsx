import { createApp } from '@backstage/app-defaults';
import { AppRouter, FlatRoutes } from '@backstage/core-app-api';
import { AlertDisplay, OAuthRequestDialog, SignInPage } from '@backstage/core-components';
import { CatalogEntityPage, CatalogIndexPage } from '@backstage/plugin-catalog';
import { InfraWalletPage } from '@electrolux-oss/plugin-infrawallet';
import { Navigate, Route } from 'react-router-dom';
import { apis } from './apis';
import { Root } from './components/Root';
import { entityPage } from './components/catalog/EntityPage';

const app = createApp({
  apis,
  components: {
    SignInPage: props => <SignInPage {...props} auto providers={['guest']} />,
  },
});

const routes = (
  <FlatRoutes>
    <Route path="/" element={<Navigate to="infrawallet" />} />
    <Route path="/catalog" element={<CatalogIndexPage />} />
    <Route path="/catalog/:namespace/:kind/:name" element={<CatalogEntityPage />}>
      {entityPage}
    </Route>
    <Route path="/infrawallet" element={<InfraWalletPage />} />
  </FlatRoutes>
);

export default app.createRoot(
  <>
    <AlertDisplay />
    <OAuthRequestDialog />
    <AppRouter>
      <Root>{routes}</Root>
    </AppRouter>
  </>,
);
