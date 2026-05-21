type BadgeTone = 'success' | 'danger' | 'info' | 'neutral' | 'accent';

type ClientOrServiceStatus = 'active' | 'suspended' | 'cancelled';

export function statusTone(status: ClientOrServiceStatus): BadgeTone {
  switch (status) {
    case 'active': return 'success';
    case 'suspended': return 'info';
    case 'cancelled': return 'neutral';
  }
}

export function statusLabel(status: ClientOrServiceStatus): string {
  switch (status) {
    case 'active': return 'Ativo';
    case 'suspended': return 'Suspenso';
    case 'cancelled': return 'Cancelado';
  }
}

export function planActiveTone(active: number): BadgeTone {
  return active ? 'success' : 'neutral';
}

export function planActiveLabel(active: number): string {
  return active ? 'Ativo' : 'Inativo';
}

export function stockLevelTone(stockTotal: number): BadgeTone {
  if (stockTotal <= 0) return 'danger';
  if (stockTotal <= 3) return 'info';
  return 'success';
}
