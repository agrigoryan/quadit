import { ColorPicker, Dot } from "@/settings/ui/bits";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** A row's colour as a dot that opens the swatches. */
export function ColorButton({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string | undefined;
  onChange: (color: string) => void;
  label: string;
  disabled?: boolean;
}) {
  if (disabled) return <Dot color={value} className="mx-1.5" />;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover data-[state=open]:bg-hover"
        >
          <Dot color={value} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3">
        <ColorPicker value={value ?? ""} onChange={onChange} label={label} />
      </PopoverContent>
    </Popover>
  );
}
