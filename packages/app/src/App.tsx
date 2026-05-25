import { createApp } from '@backstage/frontend-defaults';
import { navModule } from './modules/nav';
import { catalogNavItemOverride } from './overrides/catalog';

export default createApp({
  features: [navModule, catalogNavItemOverride],
});
