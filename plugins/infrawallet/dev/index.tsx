import { createDevApp } from '@backstage/frontend-dev-utils';
import infrawalletPlugin from '../src';

createDevApp({ features: [infrawalletPlugin] });
