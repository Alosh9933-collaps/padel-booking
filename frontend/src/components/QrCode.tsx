import { useMemo } from "react";
import qrcode from "qrcode-generator";

import { useT } from "../i18n";
import { Modal } from "./Modal";

/** A QR code drawn as one SVG path: sharp at any size, and made here, with no network needed. */
export function QrCode({ text, size = 260 }: { text: string; size?: number }) {
  const { box, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 4; // the white border scanners need, in modules
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + quiet},${row + quiet}h1v1h-1z`;
      }
    }
    return { box: count + quiet * 2, path: d };
  }, [text]);

  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" role="img" aria-label={text}>
      <rect width={box} height={box} fill="#fff" />
      <path d={path} fill="#0b2340" />
    </svg>
  );
}

/** Show the public booking page as a QR code, for customers to open it on their own phones. */
export function QrModal({ link, onClose }: { link: string; onClose: () => void }) {
  const t = useT();
  // "localhost" only exists on this computer: a phone cannot open it.
  const onlyHere = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  return (
    <Modal
      title={t("qr.title")}
      subtitle={t("qr.subtitle")}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className="qr-box">
        <QrCode text={link} />
        <code dir="ltr">{link}</code>
        {onlyHere ? <p className="alert">{t("qr.localOnly")}</p> : <p className="hint">{t("qr.sameNetwork")}</p>}
      </div>
    </Modal>
  );
}
