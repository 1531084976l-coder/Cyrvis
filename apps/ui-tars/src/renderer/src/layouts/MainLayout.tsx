import { Outlet } from 'react-router';
import { AppSidebar } from '@/renderer/src/components/SideBar/app-sidebar';
import { SidebarInset, SidebarProvider } from '@renderer/components/ui/sidebar';
import { CyrvisVoiceController } from '@renderer/components/CyrvisVoice/CyrvisVoiceController';
import { CyrvisVoiceStatusIndicator } from '@renderer/components/CyrvisVoice/CyrvisVoiceStatusIndicator';

export function MainLayout() {
  return (
    <SidebarProvider
      style={{ '--sidebar-width-icon': '72px' }}
      className="flex h-screen w-full bg-white"
    >
      <AppSidebar />
      <SidebarInset className="flex-1">
        <Outlet />
      </SidebarInset>
      <CyrvisVoiceController />
      <CyrvisVoiceStatusIndicator />
    </SidebarProvider>
  );
}
