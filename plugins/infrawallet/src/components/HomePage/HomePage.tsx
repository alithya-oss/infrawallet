import { configApiRef, useApi } from '@backstage/core-plugin-api';
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { HomePageProps } from '../types';
import { Header, Container } from '@backstage/ui';

export const HomePage = (props: HomePageProps) => {
  const { title } = props;
  const configApi = useApi(configApiRef);
  const location = useLocation();
  const navigate = useNavigate();

  const budgetsEnabled = configApi.getOptionalBoolean('infraWallet.settings.budgets.enabled') ?? true;
  const customCostsEnabled = configApi.getOptionalBoolean('infraWallet.settings.customCosts.enabled') ?? true;
  const businessMetricsEnabled = configApi.getOptionalBoolean('infraWallet.settings.businessMetrics.enabled') ?? true;
  const overviewTab = 'overview';
  const basePath = '/infrawallet';
  const tabConfig = [
    { id: overviewTab, label: 'Overview', enabled: true },
    { id: 'budgets', label: 'Budgets', enabled: budgetsEnabled },
    { id: 'custom-costs', label: 'Custom Costs', enabled: customCostsEnabled },
    { id: 'business-metrics', label: 'Business Metrics', enabled: businessMetricsEnabled },
  ];
  const activeTabs = tabConfig.filter(tab => tab.enabled);
  const pathSegments = location.pathname.split('/').filter(Boolean);
  const tabSegment = pathSegments[1];
  const activeTabIndex = activeTabs.findIndex(tab => tab.id === tabSegment);

  const headerTabs = useMemo(
    () =>
      activeTabs.map(tab => {
        let href = `${basePath}/${tab.id}`;
        if (tab.id === overviewTab) {
          const savedParams = sessionStorage.getItem('overviewParams');
          if (savedParams) {
            href += savedParams;
          }
        }
        return { id: tab.id, label: tab.label, href };
      }),
    [activeTabs, basePath, overviewTab],
  );

  useEffect(() => {
    if (tabSegment === overviewTab && location.search) {
      sessionStorage.setItem('overviewParams', location.search);
    }
  }, [tabSegment, location.search, overviewTab]);

  useEffect(() => {
    if (activeTabIndex === -1) {
      navigate(overviewTab, { replace: true });
    }
  }, [activeTabIndex, overviewTab, navigate]);

  return (
    <>
      <Header title={title ?? ''} tabs={headerTabs} />
      <Container>
        <Outlet />
      </Container>
    </>
  );
};
