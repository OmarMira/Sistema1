import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

export function useAdaptiveFeedback(companyId: string, userId: string) {
  return useMutation({
    mutationFn: async (payload: {
      bankDescription: string;
      glAccountCode: string;
      confidence?: number;
    }) => {
      const res = await fetch('/api/learning/feedback', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, userId, ...payload }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => toast.success('🧠 Sistema aprendiendo: regla candidata generada'),
    onError: () => toast.error('Error registrando feedback de aprendizaje'),
  });
}
