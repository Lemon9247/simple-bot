import { useRef, useEffect } from "react";
import type { RenderFn } from "./types";

interface ExtensionSlotProps {
    render: RenderFn;
    className?: string;
}

export default function ExtensionSlot({ render, className }: ExtensionSlotProps) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!ref.current) return;
        const cleanup = render(ref.current);
        return () => {
            cleanup?.();
            if (ref.current) ref.current.innerHTML = "";
        };
    }, [render]);

    return <div className={`extension-slot ${className ?? ""}`} ref={ref} />;
}
