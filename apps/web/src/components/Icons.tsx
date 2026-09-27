import type { SVGProps } from "react";
import { REPEATER_GLYPH, ROOM_GLYPH, SENSOR_GLYPH } from "../lib/glyphs.js";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function icon(paths: string, viewBox = "0 0 24 24") {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
        dangerouslySetInnerHTML={{ __html: paths }}
      />
    );
  };
}

export const ChatIcon = icon('<path d="M4 5h16v11H8l-4 4z"/>');
export const ContactsIcon = icon('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 14.5c2 .8 3.5 2.8 3.5 5.5"/>');
export const RadioIcon = icon('<circle cx="12" cy="13" r="2.5"/><path d="M7.5 17.5a6.5 6.5 0 0 1 0-9M16.5 8.5a6.5 6.5 0 0 1 0 9"/><path d="M4.5 20.5a10.5 10.5 0 0 1 0-15M19.5 5.5a10.5 10.5 0 0 1 0 15"/>');
export const LogIcon = icon('<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>');
export const SettingsIcon = icon('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>');
export const EyeIcon = icon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>');
export const EyeOffIcon = icon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 20L20 4"/>');
export const BackIcon = icon('<path d="M15 5l-7 7 7 7"/>');
export const SendIcon = icon('<path d="M4 12l16-8-6 16-2-6z"/>');
export const BluetoothIcon = icon('<path d="M7 7l10 10-5 4V3l5 4L7 17"/>');
export const UsbIcon = icon('<path d="M12 3v18"/><path d="M12 21l-3-3M12 21l3-3"/><path d="M12 9l4-2v4M12 13l-4-2V7"/><circle cx="12" cy="3" r="1"/>');
export const WifiIcon = icon('<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="0.75"/>');
/** A phone sharing its radio, among the radios on the connect screen. */
export const PhoneIcon = icon('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>');
/** A serial port that is not a radio's cable. */
export const PortIcon = icon('<rect x="3.5" y="8" width="17" height="8" rx="1.5"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>');

/** The icon for how the radio is reached. */
export function LinkIcon({ kind, size = 16 }: { kind: "ble" | "serial" | "tcp"; size?: number }) {
  if (kind === "ble") return <BluetoothIcon size={size} />;
  if (kind === "tcp") return <WifiIcon size={size} />;
  return <UsbIcon size={size} />;
}
export const StarIcon = icon('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/>');
export const StarFilledIcon = icon('<path fill="currentColor" d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/>');
export const RefreshIcon = icon('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>');
export const StopIcon = icon('<rect x="7" y="7" width="10" height="10" rx="1.5"/>');
export const PlayIcon = icon('<path d="M8 5.5v13l10.5-6.5z"/>');
export const CloseIcon = icon('<path d="M6 6l12 12M18 6L6 18"/>');
export const ReplyIcon = icon('<path d="M9.5 15L4 9.5 9.5 4"/><path d="M4 9.5h10a6 6 0 0 1 6 6V20"/>');
export const CheckIcon = icon('<path d="M5 12.5l4.5 4.5L19 7"/>');
export const DoubleCheckIcon = icon('<path d="M3 12.5l4.5 4.5L14 10.5"/><path d="M10 12.5l4.5 4.5L21 10.5"/>');
export const AlertIcon = icon('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>');
export const ClockIcon = icon('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>');
export const InfoIcon = icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/>');
export const PlusIcon = icon('<path d="M12 5v14M5 12h14"/>');
export const TrashIcon = icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>');
export const CopyIcon = icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>');
export const RepeaterIcon = icon(REPEATER_GLYPH);
export const RoomIcon = icon(ROOM_GLYPH);
export const SensorIcon = icon(SENSOR_GLYPH);
export const PersonIcon = icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>');
export const SignalIcon = icon('<path d="M4 18v-3M9 18v-7M14 18V7M19 18V4"/>');
export const LinkOffIcon = icon('<path d="M10 14l4-4"/><path d="M8.5 15.5l-2 2a3 3 0 0 1-4-4l2-2"/><path d="M15.5 8.5l2-2a3 3 0 0 1 4 4l-2 2"/><path d="M4 4l16 16"/>');
export const MoreIcon = icon('<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>');
export const MapIcon = icon('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>');
export const MinusIcon = icon('<path d="M5 12h14"/>');
export const LocateIcon = icon('<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>');
export const FitIcon = icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>');
export const GroupIcon = icon('<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><circle cx="12" cy="16.5" r="3"/>');
export const LocationIcon = icon('<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>');
export const BatteryIcon = icon('<rect x="2.5" y="7" width="16.5" height="10" rx="2"/><path d="M21.5 10.5v3M6 10.5v3M9 10.5v3"/>');
export const PowerIcon = icon('<path d="M12 3v8"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>');
export const NodesIcon = icon('<circle cx="12" cy="5.5" r="2.5"/><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M10.8 7.7 6.8 15.3M13.2 7.7l4 7.6M8 17.5h8"/>');
export const LockIcon = icon('<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>');
export const DownIcon = icon('<path d="M12 5v14M6 13l6 6 6-6"/>');
export const ChevronDownIcon = icon('<path d="M7 10l5 5 5-5"/>');
export const ChevronUpIcon = icon('<path d="M7 14l5-5 5 5"/>');
/** The order of a list. */
export const SortIcon = icon('<path d="M4 7h16M7 12h10M10 17h4"/>');
/** A flood: messages that go everywhere rather than along a route. */
export const WavesIcon = icon(
  '<path d="M3 8.5c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0 3-1.4 4.5 0 3 1.4 4.5 0"/><path d="M3 13c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0 3-1.4 4.5 0 3 1.4 4.5 0"/><path d="M3 17.5c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0 3-1.4 4.5 0 3 1.4 4.5 0"/>',
);
/** A coverage survey: a drive with a point every so often. */
export const SurveyIcon = icon('<path d="M4 18.5c3.5 0 4-5 8-5s4.5-5 8-5"/><circle cx="4" cy="18.5" r="1.6"/><circle cx="12" cy="13.5" r="1.6"/><circle cx="20" cy="8.5" r="1.6"/>');
/** A file handed on: to the share sheet, or downloaded. */
export const ShareIcon = icon('<path d="M12 14.5v-11M8 7.5l4-4 4 4"/><path d="M7 10.5H5.5v10h13v-10H17"/>');
export const FileIcon = icon('<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/>');
export const PauseIcon = icon('<path d="M9 6.5v11M15 6.5v11"/>');
/** Marks an action that transmits: it costs airtime, and happens only when asked. */
export const AirIcon = icon('<path d="M12 21v-8.5"/><circle cx="12" cy="10.5" r="1.6"/><path d="M8.3 7a5.2 5.2 0 0 0 0 7M15.7 7a5.2 5.2 0 0 1 0 7"/><path d="M5.6 4.4a9 9 0 0 0 0 12.2M18.4 4.4a9 9 0 0 1 0 12.2"/>');
export const SearchIcon = icon('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>');
export const ChevronRightIcon = icon('<path d="M9 5l7 7-7 7"/>');
export const EditIcon = icon('<path d="M4 20h4L19 9l-4-4L4 16z"/>');
export const HashIcon = icon('<path d="M9 4L7 20M17 4l-2 16M4.5 9h15M3.5 15h15"/>');
export const KeyIcon = icon('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>');
export const BellOffIcon = icon('<path d="M8.5 5.2A6 6 0 0 1 18 11v4.5"/><path d="M6 11v5l-1.5 2H18"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M3.5 3.5l17 17"/>');
export const BellIcon = icon('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>');
export const PaletteIcon = icon('<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.7-.8 1.4-1.8-.4-1.2.4-2.2 1.6-2.2H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="11" r="1"/>');
export const ShieldIcon = icon('<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/>');
export const SlidersIcon = icon('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>');
export const TextIcon = icon('<path d="M5 6h14M12 6v13M8 19h8"/>');
export const TerminalIcon = icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>');
export const GaugeIcon = icon('<path d="M4.5 16.5a7.5 7.5 0 1 1 15 0"/><path d="M12 16.5l3.5-4.5"/>');
export const ChartIcon = icon('<path d="M4 19h16"/><path d="M6 15l4-5 3 3 5-7"/>');
export const UsersIcon = icon('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 14.5c2 .8 3.5 2.8 3.5 5.5"/>');
