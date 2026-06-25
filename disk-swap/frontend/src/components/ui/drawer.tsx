import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";

import { cn } from "@/lib/utils";

type Direction = "top" | "right" | "bottom" | "left";

const DrawerDirectionContext = React.createContext<Direction>("right");

const SWIPE_DIRECTION: Record<Direction, "up" | "down" | "left" | "right"> = {
  top: "up",
  right: "right",
  bottom: "down",
  left: "left",
};

function Drawer({ direction = "right", ...props }: DrawerPrimitive.Root.Props & { direction?: Direction }) {
  return (
    <DrawerDirectionContext.Provider value={direction}>
      <DrawerPrimitive.Root data-slot="drawer" swipeDirection={SWIPE_DIRECTION[direction]} {...props} />
    </DrawerDirectionContext.Provider>
  );
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({ className, ...props }: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      // No z-index — Base UI's nested-drawer close-on-outside-click relies on the inner Drawer's
      // auto-rendered InternalBackdrop sitting on top by DOM order. Forcing a z-index here would
      // intercept clicks meant for the inner backdrop.
      className={cn("fixed inset-0 bg-black/10 supports-backdrop-filter:backdrop-blur-xs", className)}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  onOverlayClick,
  ...props
}: DrawerPrimitive.Popup.Props & { onOverlayClick?: () => void }) {
  const direction = React.useContext(DrawerDirectionContext);
  return (
    <DrawerPortal>
      <DrawerOverlay onPointerDown={onOverlayClick} />
      <DrawerPrimitive.Viewport>
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          data-direction={direction}
          className={cn(
            // No z-index — Base UI's nested-drawer click-outside relies on the inner drawer's
            // auto-rendered InternalBackdrop sitting above the parent popup by DOM order. A
            // hardcoded z-index would intercept clicks meant for that backdrop.
            "group/drawer-content fixed flex h-auto flex-col bg-background text-sm shadow-xl",
            "data-[direction=bottom]:inset-x-0 data-[direction=bottom]:bottom-0 data-[direction=bottom]:mt-24 data-[direction=bottom]:max-h-[80vh] data-[direction=bottom]:rounded-t-xl data-[direction=bottom]:border-t",
            "data-[direction=left]:inset-y-0 data-[direction=left]:left-0 data-[direction=left]:w-3/4 data-[direction=left]:rounded-r-xl data-[direction=left]:border-r",
            "data-[direction=right]:inset-y-0 data-[direction=right]:right-0 data-[direction=right]:w-3/4 data-[direction=right]:rounded-l-xl data-[direction=right]:border-l",
            "data-[direction=top]:inset-x-0 data-[direction=top]:top-0 data-[direction=top]:mb-24 data-[direction=top]:max-h-[80vh] data-[direction=top]:rounded-b-xl data-[direction=top]:border-b",
            className,
          )}
          {...props}
        >
          <DrawerPrimitive.Content className="flex min-h-0 flex-1 flex-col">{children}</DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex flex-col gap-0.5 p-4 md:gap-1.5 md:text-left",
        "group-data-[direction=bottom]/drawer-content:text-center group-data-[direction=top]/drawer-content:text-center",
        className,
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="drawer-footer" className={cn("mt-auto flex flex-col gap-2 p-4", className)} {...props} />;
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-foreground font-medium", className)}
      {...props}
    />
  );
}

function DrawerDescription({ className, ...props }: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export const DRAWER_MAX_WIDTH = "data-[direction=right]:max-w-250";

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
