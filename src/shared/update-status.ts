/** O que o renderer sabe da atualização automática (main → preload → rodapé da barra lateral). */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'downloading'; version: string; percent: number; transferred: number; total: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };
