import { HumanDuration } from '@backstage/types';

export interface Config {
  backend: {
    infraWallet: {
      autoload?: {
        enabled?: boolean;
        schedule?: string;
        initialDelayMinutes?: number;
      };
      integrations: {
        azure?: {
          name: string;
          subscriptionId: string;
          clientId: string;
          tenantId: string;
          /**
           * @visibility secret
           */
          clientSecret: string;
          tags?: string[];
        }[];
        aws?: {
          name: string;
          accountId: string;
          assumedRoleName?: string;
          /**
           * @visibility secret
           */
          accessKeyId?: string;
          /**
           * @visibility secret
           */
          secretAccessKey?: string;
          /**
           * @visibility secret
           */
          accessKeySecret?: string; // Deprecated Use 'secretAccessKey' instead.
          tags?: string[];
          filters?: [
            {
              type: string;
              attribute: string;
              pattern: string;
            },
          ];
        }[];
        gcp?: {
          name: string;
          /**
           * @visibility secret
           */
          keyFilePath: string;
          projectId: string;
          datasetId: string;
          tableId: string;
          tags?: string[];
        }[];
        confluent?: {
          name: string;
          /**
           * @visibility secret
           */
          apiKey: string;
          /**
           * @visibility secret
           */
          apiSecret: string;
          tags?: string[];
        }[];
        mongoatlas?: {
          name: string;
          orgId: string;
          /**
           * @visibility secret
           */
          publicKey: string;
          /**
           * @visibility secret
           */
          privateKey: string;
          tags?: string[];
        }[];
        datadog?: {
          name: string;
          /**
           * @visibility secret
           */
          apiKey: string;
          /**
           * @visibility secret
           */
          applicationKey: string;
          ddSite: string;
          filters?: [
            {
              type: string;
              attribute: string;
              pattern: string;
            },
          ];
        }[];
        elasticcloud?: {
          name: string;
          organizationId: string;
          /**
           * @visibility secret
           */
          apiKey: string;
          tags?: string[];
          filters?: [
            {
              type: string;
              attribute: string;
              pattern: string;
            },
          ];
        }[];
        github?: {
          name: string;
          organization: string;
          /**
           * @visibility secret
           */
          token: string;
        }[];
        kubecost?: {
          name: string;
          baseUrl: string;
          /**
           * API version to use for the Kubecost endpoint.
           * - 'v1': Kubecost 1.x (endpoint: /model/allocation, accumulate as boolean)
           * - 'v2': Kubecost 2.x (endpoint: /model/allocation, accumulate as string)
           * - 'v3': Kubecost 3.x (same API as v2)
           * @default 'v1'
           */
          apiVersion?: 'v1' | 'v2' | 'v3';
          /**
           * Field by which to aggregate the results.
           * Accepts: cluster, namespace, controllerKind, controller, service, node, pod, label:<name>, and annotation:<name>.
           * Also accepts comma-separated lists for multi-aggregation, like namespace,label:app.
           * * @default 'namespace'
           */
          aggregate?: string;
          /**
           * Maximum metrics retention window. Kubecost free tier retains 15 days.
           * Accepts HumanDuration format, e.g. { days: 15 }, { hours: 360 }.
           * @default { days: 15 }
           */
          maxMetricsRetention?: HumanDuration;
          tags?: string[];
          filters?: [
            {
              type: string;
              attribute: string;
              pattern: string;
            },
          ];
        }[];
        mock?: {
          name: string;
        }[];
      };
      metricProviders?: {
        datadog?: {
          name: string;
          /**
           * @visibility secret
           */
          apiKey: string;
          /**
           * @visibility secret
           */
          applicationKey: string;
          ddSite: string;
        }[];
        grafanaCloud?: {
          name: string;
          url: string;
          datasourceUid: string;
          /**
           * @visibility secret
           */
          token: string;
        }[];
        mock?: {
          name: string;
        }[];
      };
    };
  };
}
