import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';
import { Select } from './Select';

type PaginationControlsProps = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  start: number;
  end: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};

export function PaginationControls({
  page,
  pageSize,
  total,
  totalPages,
  start,
  end,
  pageSizeOptions = [10, 25, 50],
  onPageChange,
  onPageSizeChange
}: PaginationControlsProps) {
  if (total <= pageSizeOptions[0]) return null;

  return (
    <div className="pagination-controls" aria-label="Paginação">
      <small className="pagination-range">
        {start}-{end} de {total}
      </small>
      <div className="pagination-actions">
        <Select
          label="Linhas"
          value={String(pageSize)}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          className="pagination-size"
        >
          {pageSizeOptions.map((option) => (
            <option value={option} key={option}>{option}</option>
          ))}
        </Select>
        <Button
          variant="icon"
          size="sm"
          aria-label="Página anterior"
          title="Página anterior"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={16} aria-hidden />
        </Button>
        <span className="pagination-page">Página {page} / {totalPages}</span>
        <Button
          variant="icon"
          size="sm"
          aria-label="Página seguinte"
          title="Página seguinte"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={16} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
