import { FrontendFeature } from '@backstage/frontend-plugin-api';
import catalogPlugin from '@backstage/plugin-catalog/alpha';

import { entityOverviewLayoutExtension } from '../components/catalog/EntityOverviewLayout';

export const catalogNavItemOverride: FrontendFeature = catalogPlugin.withOverrides({
  extensions: [entityOverviewLayoutExtension],
});
