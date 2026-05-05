import {
  Link,
  Sidebar,
  SidebarDivider,
  SidebarItem,
  SidebarPage,
  SidebarSpace,
  sidebarConfig,
  useSidebarOpenState,
} from '@backstage/core-components';
import { InfraWalletIcon } from '@electrolux-oss/plugin-infrawallet';
import { styled } from '@mui/material/styles';
import CategoryIcon from '@mui/icons-material/Category';
import { PropsWithChildren} from 'react';
import LogoFull from './LogoFull';
import LogoIcon from './LogoIcon';

const SidebarLogoRoot = styled('div')(() => ({
  width: sidebarConfig.drawerWidthClosed,
  height: 3 * sidebarConfig.logoHeight,
  display: 'flex',
  flexFlow: 'row nowrap',
  alignItems: 'center',
  marginBottom: -14,
}));

const SidebarLogoLink = styled(Link)(() => ({
  width: sidebarConfig.drawerWidthClosed,
  marginLeft: 24,
}));

const SidebarLogo = () => {
  const { isOpen } = useSidebarOpenState();

  return (
    <SidebarLogoRoot>
      <SidebarLogoLink to="/" underline="none" aria-label="Home">
        {isOpen ? <LogoFull /> : <LogoIcon />}
      </SidebarLogoLink>
    </SidebarLogoRoot>
  );
};

export const Root = ({ children }: PropsWithChildren<{}>) => (
  <SidebarPage>
    <Sidebar>
      <SidebarLogo />
      <SidebarDivider />
      <SidebarItem icon={CategoryIcon} to="catalog" text="Catalog" />
      <SidebarItem icon={InfraWalletIcon} to="infrawallet" text="InfraWallet" />
      <SidebarSpace />
    </Sidebar>
    {children}
  </SidebarPage>
);
