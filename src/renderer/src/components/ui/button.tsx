import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background,box-shadow,transform] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 active:scale-[0.98] [&_svg]:size-4 [&_svg]:shrink-0 select-none",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/70',
        destructive:
          'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
        outline:
          'border border-border-strong bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
        signal:
          'bg-signal text-signal-foreground shadow-xs hover:bg-signal/90'
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 rounded-md px-3 text-[0.8125rem]',
        lg: 'h-10 rounded-md px-5',
        icon: 'h-9 w-9',
        'icon-sm': 'h-7 w-7 rounded-[calc(var(--radius)-3px)] [&_svg]:size-3.5'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
