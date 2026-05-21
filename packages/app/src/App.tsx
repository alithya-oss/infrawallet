import { createApp } from '@backstage/frontend-defaults';
import { navModule } from './modules/nav';

export default createApp({
  features: [navModule],
});
