import { RotateCcw } from 'lucide-react';
import { Button, Textarea } from '../../components';
import { templateRows, type SettingsFormState, type UpdateField } from './settingsForm';

type TemplateFieldProps = {
  field: keyof SettingsFormState;
  label: string;
  hint?: string;
  value: string;
  /** O texto por omissão atual; um modelo gravado nunca é trocado sem o utilizador pedir. */
  recommended: string;
  onUpdate: UpdateField;
};

export function TemplateField({ field, label, hint, value, recommended, onUpdate }: TemplateFieldProps) {
  return (
    <div className="wide-field template-field">
      <Textarea
        className="whatsapp-template-field"
        wide={false}
        label={label}
        hint={hint}
        rows={templateRows(value)}
        value={value}
        onChange={(event) => onUpdate(field, event.target.value)}
      />
      {value !== recommended ? (
        <Button variant="ghost" size="sm" leadingIcon={<RotateCcw size={14} aria-hidden />} onClick={() => onUpdate(field, recommended)}>
          Usar texto recomendado
        </Button>
      ) : null}
    </div>
  );
}
