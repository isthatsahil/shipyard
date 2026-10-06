import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import i18n from "i18next";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { ApiError } from "@/api/client";
import { formatUserMessage } from "@/i18n/formatMessage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // A 4xx won't succeed on retry; a network blip or a 5xx might.
      retry: (count, err) =>
        !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
  mutationCache: new MutationCache({
    onError: (err, _variables, _context, mutation) => {
      if (mutation.meta?.silent) return;
      toast.error(formatUserMessage(i18n, err as ApiError, err.message));
    },
  }),
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
