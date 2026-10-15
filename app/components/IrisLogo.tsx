interface IrisLogoProps {
	size?: number;
	className?: string;
}

export default function IrisLogo({ size = 20, className = "" }: IrisLogoProps) {
	return (
		<img
			src="/iris-logo.svg"
			alt=""
			aria-hidden="true"
			draggable={false}
			width={size}
			height={size}
			className={`inline-block shrink-0 object-contain ${className}`}
		/>
	);
}
