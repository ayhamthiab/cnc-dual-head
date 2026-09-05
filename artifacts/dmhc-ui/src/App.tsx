import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Layout } from '@/components/layout';

import Home from '@/pages/home';
import Jobs from '@/pages/jobs';
import Viz from '@/pages/viz';
import Machine from '@/pages/machine';
import AutomatedDrawingList from '@/pages/automated-drawing-list';
import AutomatedDrawing from '@/pages/automated-drawing';

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/machine" component={Machine} />
        <Route path="/viz/:id" component={Viz} />
        <Route path="/automated-drawing" component={AutomatedDrawingList} />
        <Route path="/automated-drawing/:id" component={AutomatedDrawing} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
