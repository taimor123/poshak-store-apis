import { PrismaClient, SizeMode, ProductStatus, Role, Piece, AttrType } from '@prisma/client'

import 'dotenv/config'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  console.log('Seeding database...')

  // Clear existing
  await prisma.productSizeOverride.deleteMany()
  await prisma.fabricContent.deleteMany()
  await prisma.productAttributeValue.deleteMany()
  await prisma.productImage.deleteMany()
  await prisma.inventoryLedger.deleteMany()
  await prisma.productVariant.deleteMany()
  await prisma.product.deleteMany()
  
  await prisma.attributeValueOption.deleteMany()
  await prisma.attributeDefinition.deleteMany()
  
  await prisma.category.deleteMany()
  await prisma.attributeSet.deleteMany()
  
  await prisma.sizeChartCell.deleteMany()
  await prisma.sizeChart.deleteMany()
  await prisma.sizeDefinition.deleteMany()

  // 1. Size Definitions (Level 1)
  console.log('Seeding Size Definitions...')
  const sizes = ['XS', 'S', 'M', 'L', 'XL', 'Free Size']
  const sizeMap: Record<string, string> = {}
  for (let i = 0; i < sizes.length; i++) {
    const s = await prisma.sizeDefinition.create({
      data: { label: sizes[i], sortOrder: i + 1 }
    })
    sizeMap[sizes[i]] = s.id
  }

  // 2. Size Charts (Level 2)
  console.log('Seeding Size Charts...')
  const pretChart = await prisma.sizeChart.create({
    data: {
      name: 'Pret Default',
      dimensions: ['Chest', 'Waist', 'Hip', 'Shoulder', 'Sleeve Length', 'Kameez Length'],
    }
  })
  
  const pretMeasurements = {
    'S': { 'Chest': 38, 'Waist': 34, 'Hip': 40, 'Shoulder': 14, 'Sleeve Length': 21, 'Kameez Length': 38 },
    'M': { 'Chest': 40, 'Waist': 36, 'Hip': 42, 'Shoulder': 14.5, 'Sleeve Length': 22, 'Kameez Length': 38 },
    'L': { 'Chest': 43, 'Waist': 39, 'Hip': 45, 'Shoulder': 15, 'Sleeve Length': 22.5, 'Kameez Length': 39 },
  }
  
  for (const [size, dims] of Object.entries(pretMeasurements)) {
    for (const [dim, val] of Object.entries(dims)) {
      await prisma.sizeChartCell.create({
        data: {
          chartId: pretChart.id,
          sizeId: sizeMap[size],
          dimension: dim,
          valueInches: val
        }
      })
    }
  }

  // 3. Attribute Sets & Definitions
  console.log('Seeding Attribute Sets...')
  const pretAttrSet = await prisma.attributeSet.create({ data: { name: 'pret-base' } })
  const unstitchedAttrSet = await prisma.attributeSet.create({ data: { name: 'unstitched-base' } })

  const fabricDef = await prisma.attributeDefinition.create({
    data: {
      setId: pretAttrSet.id, key: 'fabric', label: 'Fabric', type: AttrType.MULTI_SELECT,
      filterable: true, required: true, sortOrder: 1
    }
  })
  const colorDef = await prisma.attributeDefinition.create({
    data: {
      setId: pretAttrSet.id, key: 'color', label: 'Color', type: AttrType.SELECT,
      filterable: true, required: true, sortOrder: 2
    }
  })
  const piecesDef = await prisma.attributeDefinition.create({
    data: {
      setId: pretAttrSet.id, key: 'pieces', label: 'Pieces', type: AttrType.SELECT,
      filterable: true, required: true, sortOrder: 3
    }
  })
  
  const colors = ['Red', 'Maroon', 'Navy', 'Black', 'White', 'Beige', 'Green', 'Yellow', 'Pink']
  for (let i = 0; i < colors.length; i++) {
    await prisma.attributeValueOption.create({
      data: { definitionId: colorDef.id, value: colors[i], label: colors[i], sortOrder: i + 1, active: true }
    })
  }

  const fabrics = ['Lawn', 'Cotton', 'Khaddar', 'Chiffon', 'Silk']
  for (let i = 0; i < fabrics.length; i++) {
    await prisma.attributeValueOption.create({
      data: { definitionId: fabricDef.id, value: fabrics[i], label: fabrics[i], sortOrder: i + 1, active: true }
    })
  }
  
  await prisma.attributeValueOption.create({ data: { definitionId: piecesDef.id, value: '1-Piece', label: '1-Piece', sortOrder: 1, active: true } })
  await prisma.attributeValueOption.create({ data: { definitionId: piecesDef.id, value: '2-Piece', label: '2-Piece', sortOrder: 2, active: true } })
  await prisma.attributeValueOption.create({ data: { definitionId: piecesDef.id, value: '3-Piece', label: '3-Piece', sortOrder: 3, active: true } })

  const unstFabricDef = await prisma.attributeDefinition.create({
    data: { setId: unstitchedAttrSet.id, key: 'fabric', label: 'Fabric', type: AttrType.MULTI_SELECT, filterable: true, required: true, sortOrder: 1 }
  })
  await prisma.attributeValueOption.create({ data: { definitionId: unstFabricDef.id, value: 'Lawn', label: 'Lawn', sortOrder: 1, active: true } })
  const unstColorDef = await prisma.attributeDefinition.create({
    data: { setId: unstitchedAttrSet.id, key: 'color', label: 'Color', type: AttrType.SELECT, filterable: true, required: true, sortOrder: 2 }
  })
  await prisma.attributeValueOption.create({ data: { definitionId: unstColorDef.id, value: 'Red', label: 'Red', sortOrder: 1, active: true } })


  // 4. Categories
  console.log('Seeding Categories...')
  const rtw = await prisma.category.create({
    data: { name: 'Ready to Wear', slug: 'ready-to-wear', sortOrder: 1, sizeMode: SizeMode.STITCHED, isActive: true }
  })
  const kurtis = await prisma.category.create({
    data: { name: 'Kurtis', slug: 'kurtis', sortOrder: 1, sizeMode: SizeMode.STITCHED, isActive: true, parentId: rtw.id, sizeChartId: pretChart.id, attributeSetId: pretAttrSet.id }
  })
  const threePiece = await prisma.category.create({
    data: { name: '3-Piece Suits', slug: 'pret-3-piece-suits', sortOrder: 3, sizeMode: SizeMode.STITCHED, isActive: true, parentId: rtw.id, sizeChartId: pretChart.id, attributeSetId: pretAttrSet.id }
  })
  
  const unstitched = await prisma.category.create({
    data: { name: 'Unstitched', slug: 'unstitched', sortOrder: 2, sizeMode: SizeMode.UNSTITCHED, isActive: true }
  })
  const unst3Piece = await prisma.category.create({
    data: { name: '3-Piece Suits', slug: 'unstitched-3-piece-suits', sortOrder: 1, sizeMode: SizeMode.UNSTITCHED, isActive: true, parentId: unstitched.id, attributeSetId: unstitchedAttrSet.id }
  })

  // 5. Products
  console.log('Seeding Products...')
  
  for (let i = 1; i <= 20; i++) {
    const isPret = i <= 10;
    const cat = isPret ? (i <= 5 ? kurtis : threePiece) : unst3Piece;
    const sizeMode = cat.sizeMode;

    const prod = await prisma.product.create({
      data: {
        categoryId: cat.id,
        name: `Demo Product ${i}`,
        slug: `demo-product-${i}`,
        code: `PSK-100${i}`,
        description: `This is a beautiful ${cat.name} suitable for any occasion.`,
        pricePaisa: 500000 + (i * 10000),
        status: ProductStatus.PUBLISHED,
        publishedAt: new Date()
      }
    })

    await prisma.productImage.create({
      data: {
        productId: prod.id,
        url: `https://images.unsplash.com/photo-1550614000-4b95d466f12a?auto=format&fit=crop&w=800&q=80`,
        altText: `Demo Product ${i}`,
        sortOrder: 1,
        isCover: true
      }
    })

    if (sizeMode === SizeMode.STITCHED) {
      const offeredSizes = ['S', 'M', 'L']
      for (const s of offeredSizes) {
        await prisma.productVariant.create({
          data: {
            productId: prod.id,
            sizeId: sizeMap[s],
            color: 'Red',
            sku: `PSK-100${i}-${s}-RED`,
            stock: 10
          }
        })
      }
      
      await prisma.productAttributeValue.createMany({
        data: [
          { productId: prod.id, definitionId: colorDef.id, value: '"Red"' },
          { productId: prod.id, definitionId: fabricDef.id, value: '["Lawn"]' },
          { productId: prod.id, definitionId: piecesDef.id, value: cat.id === kurtis.id ? '"1-Piece"' : '"3-Piece"' }
        ]
      })

      if (i === 1) {
        await prisma.productSizeOverride.create({
          data: {
            productId: prod.id,
            sizeId: sizeMap['M'],
            dimension: 'Chest',
            valueInches: 38
          }
        })
        await prisma.product.update({
          where: { id: prod.id },
          data: { fitNote: 'Slim cut — size up for a relaxed fit.' }
        })
      }

    } else {
      await prisma.productVariant.create({
        data: {
          productId: prod.id,
          sku: `PSK-100${i}-UNST`,
          stock: 50
        }
      })

      await prisma.productAttributeValue.createMany({
        data: [
          { productId: prod.id, definitionId: unstColorDef.id, value: '"Red"' },
          { productId: prod.id, definitionId: unstFabricDef.id, value: '["Lawn"]' }
        ]
      })
      
      await prisma.fabricContent.create({
        data: { productId: prod.id, piece: Piece.SHIRT, fabric: 'Lawn', lengthMeters: 3.0, detail: 'Embroidered front' }
      })
      await prisma.fabricContent.create({
        data: { productId: prod.id, piece: Piece.DUPATTA, fabric: 'Chiffon', lengthMeters: 2.5 }
      })
      await prisma.fabricContent.create({
        data: { productId: prod.id, piece: Piece.TROUSER, fabric: 'Cambric', lengthMeters: 2.5 }
      })
    }
  }

  console.log('Seed completed successfully.')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
