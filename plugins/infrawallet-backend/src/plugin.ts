import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { InfrawalletFilterExtension, infrawalletReportFilterExtensionPoint } from './extension';
import { createRouter } from './service/router';
import { CostFetchTaskScheduler } from './service/scheduler';
import { LoggerService } from '@backstage/backend-plugin-api';

/**
 * infraWalletPlugin backend plugin
 *
 * @public
 */
export const infraWalletPlugin = createBackendPlugin({
  pluginId: 'infrawallet',
  register(env) {
    const additionalFilters: Array<InfrawalletFilterExtension> = [];

    env.registerExtensionPoint(infrawalletReportFilterExtensionPoint, {
      addReportFilter(filter: InfrawalletFilterExtension) {
        additionalFilters.push(filter);
      },
    });

    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        scheduler: coreServices.scheduler,
        cache: coreServices.cache,
        database: coreServices.database,
      },
      async init({ httpRouter, logger, config, scheduler, cache, database }) {
        // 1. Register the HTTP endpoints
        httpRouter.use(
          await createRouter({
            logger,
            config,
            scheduler,
            cache,
            database,
            additionalFilters,
          }),
        );

        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });

        // 2. Initialize the task scheduler
        const taskLogger = logger.child({ component: 'CostFetchTaskScheduler' }) as LoggerService;
        const taskScheduler = new CostFetchTaskScheduler({
          scheduler,
          logger: taskLogger,
          config,
          cache,
          database,
        });

        await taskScheduler.initialize();
      },
    });
  },
});
