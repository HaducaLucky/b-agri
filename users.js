// Default users (in production, use encrypted passwords)
window.users = [
  {
    id: 1,
    username: "admin",
    password: "admin123", // In real app → hash this!
    name: "System Administrator",
    role: "Administrator"
  },
  {
    id: 2,
    username: "encoder",
    password: "enc123",
    name: "Field Encoder",
    role: "Encoder"
  },
  {
    id: 3,
    username: "user",
    password: "user123",
    name: "Municipal Officer",
    role: "User"
  }
];