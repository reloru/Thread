### 1. Solving the quadratic equation \(x^2 - 5x + 6 = 0\) using the quadratic formula  
The quadratic formula is:  
$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$  
For the equation \(x^2 - 5x + 6 = 0\), the coefficients are:  
- \(a = 1\) (coefficient of \(x^2\))  
- \(b = -5\) (coefficient of \(x\))  
- \(c = 6\) (constant term)  

#### Step-by-step solution:  
1. **Compute the discriminant** (the part under the square root):  
   $$
   \Delta = b^2 - 4ac = (-5)^2 - 4(1)(6) = 25 - 24 = 1
   $$  
2. **Take the square root of the discriminant**:  
   $$
   \sqrt{\Delta} = \sqrt{1} = 1
   $$  
3. **Plug into the quadratic formula for both roots**:  
   - First root:  
     $$
     x_1 = \frac{-(-5) + 1}{2(1)} = \frac{5 + 1}{2} = \frac{6}{2} = 3
     $$  
   - Second root:  
     $$
     x_2 = \frac{-(-5) - 1}{2(1)} = \frac{5 - 1}{2} = \frac{4}{2} = 2
     $$  
4. **Solutions**:  
   $$\boxed{x = 2 \quad \text{or} \quad x = 3}$$  

---

### 2. Integral of \(e^{-x^2}\) over the whole real line  
The Gaussian integral is:  
$$
\int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}
$$  
This is a foundational result in analysis and statistics. The proof involves squaring the integral and switching to polar coordinates, which we won't derive here, but it is well-established.  

---

### 3. Standard deviation of a sample  
The standard deviation (denoted \(\sigma\)) of a sample is a measure of how spread out the values are from the mean. For a sample of size \(n\) with values \(x_1, x_2, \dots, x_n\):  

- **Step 1: Compute the sample mean** \(\bar{x}\):  
  $$
  \bar{x} = \frac{1}{n} \sum_{i=1}^{n} x_i
  $$  
- **Step 2: Compute the squared deviations from the mean** for each value.  
- **Step 3: Take the average of those squared deviations** (this is the **sample variance**):  
  $$
  s^2 = \frac{1}{n} \sum_{i=1}^{n} (x_i - \bar{x})^2
  $$  
  (Note: In practice, some use \(n-1\) instead of \(n\) for an unbiased estimate, but the basic definition uses \(n\).)  
- **Step 4: Take the square root of the variance** to get the standard deviation:  
  $$
  s = \sqrt{s^2} = \sqrt{\frac{1}{n} \sum_{i=1}^{n} (x_i - \bar{x})^2}
  $$  

In symbols:  
$$
\boxed{\text{Sample Standard Deviation } s = \sqrt{\frac{1}{n} \sum_{i=1}^{n} (x_i - \bar{x})^2}}
$$  
This quantifies the average distance of each data point from the sample mean.