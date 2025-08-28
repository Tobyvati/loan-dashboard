// Server Component mặc định trong App Router
import { redirect } from 'next/navigation';

export default function Home() {
  // Khi mở trang gốc "/", tự chuyển sang "/loans"
  redirect('/loans');
}