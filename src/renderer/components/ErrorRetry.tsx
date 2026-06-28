import { RotateCw } from 'lucide-react';
import { Button } from './Button';

type ErrorRetryProps = {
  message?: string;
  onRetry: () => void;
};

/** Estado de falha de carregamento com ação de tentar de novo. */
export function ErrorRetry({ message = 'Não foi possível carregar os dados.', onRetry }: ErrorRetryProps) {
  return (
    <div className="error-retry" role="alert">
      <p className="module-message error">{message}</p>
      <Button variant="secondary" size="sm" leadingIcon={<RotateCw size={14} aria-hidden />} onClick={onRetry}>
        Tentar de novo
      </Button>
    </div>
  );
}
