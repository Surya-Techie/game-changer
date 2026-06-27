import { motion, type HTMLMotionProps } from "framer-motion";
import clsx from "clsx";

type Props = HTMLMotionProps<"div"> & { children: React.ReactNode };

export default function GlassCard({ children, className, ...rest }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={clsx(
        "relative rounded-2xl border border-bg-border bg-bg-panel backdrop-blur-glass shadow-glass overflow-hidden",
        "before:absolute before:inset-0 before:rounded-2xl before:bg-panel-glow before:opacity-75 before:-z-10",
        className
      )}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
