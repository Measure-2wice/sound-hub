import type { ReactNode } from "react";

type PropsWithChildren<P = Record<string, never>> = P & { children?: ReactNode };

// Main Card component
interface CardProps {
  children?: ReactNode;
  variant?: "default" | "elevated" | "outlined";
  className?: string;
}

function CardRoot({ children, variant = "default", className = "" }: CardProps) {
  const baseClasses = "rounded-lg overflow-hidden";
  const variantClasses = {
    default: "bg-white border border-gray-200",
    elevated: "bg-white shadow-lg",
    outlined: "bg-white border-2 border-gray-300",
  };

  return <div className={`${baseClasses} ${variantClasses[variant]} ${className}`}>{children}</div>;
}

// Compound components
function CardHeader({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <div className={`px-6 py-4 border-b border-gray-200 ${className}`}>{children}</div>;
}

function CardContent({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <div className={`px-6 py-4 ${className}`}>{children}</div>;
}

function CardFooter({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`px-6 py-4 border-t border-gray-200 bg-gray-50 ${className}`}>{children}</div>
  );
}

function CardTitle({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <h3 className={`text-lg font-semibold text-gray-900 ${className}`}>{children}</h3>;
}

function CardDescription({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <p className={`text-sm text-gray-600 mt-1 ${className}`}>{children}</p>;
}

// Export as compound component
export const Card = Object.assign(CardRoot, {
  Header: CardHeader,
  Content: CardContent,
  Footer: CardFooter,
  Title: CardTitle,
  Description: CardDescription,
});

// Usage:
// <Card variant="elevated">
//   <Card.Header>
//     <Card.Title>Producer Name</Card.Title>
//     <Card.Description>Electronic, Hip-Hop</Card.Description>
//   </Card.Header>
//   <Card.Content>
//     Bio content here...
//   </Card.Content>
//   <Card.Footer>
//     <Button>Contact</Button>
//   </Card.Footer>
// </Card>
